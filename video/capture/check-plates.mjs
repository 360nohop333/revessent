#!/usr/bin/env node
// Plate QA — since we can't eyeball 3200×2000 PNGs in this terminal, this
// loads each plate back into chromium and computes visual stats + a coarse
// brightness map, so layout disasters (blank page, white flash, missing
// sidebar) are caught numerically.
import fs from 'node:fs';
function b64(file) { return 'data:image/png;base64,' + fs.readFileSync(file).toString('base64'); }
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PLATES = path.resolve(__dirname, '../src/plates');

const browser = await puppeteer.launch({
  executablePath: '/tmp/chromium',
  headless: 'shell',
  env: { ...process.env, LD_LIBRARY_PATH: '/tmp/al2023/lib', FONTCONFIG_PATH: '/tmp/fonts' },
  args: ['--no-sandbox', '--no-zygote', '--disable-gpu', '--disable-dev-shm-usage'],
});
const page = await browser.newPage();
await page.setViewport({ width: 400, height: 250 });

const files = process.argv[2] ? [process.argv[2]] : fs.readdirSync(PLATES).filter((f) => f.endsWith('.png'));
for (const f of files) {
  const stats = await page.evaluate(async (dataUrl) => {
    const img = new Image();
    img.src = dataUrl;
    await img.decode();
    const w = 160, h = 100; // downscale
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const d = ctx.getImageData(0, 0, w, h).data;
    let dark = 0, light = 0, mint = 0, red = 0, sum = 0;
    const grid = [];
    for (let y = 0; y < 10; y++) {
      let row = '';
      for (let x = 0; x < 16; x++) {
        // sample cell center
        const px = Math.floor((x + 0.5) * w / 16), py = Math.floor((y + 0.5) * h / 10);
        const i = (py * w + px) * 4;
        const r = d[i], g = d[i + 1], b = d[i + 2];
        const lum = (r + g + b) / 3;
        row += lum < 30 ? '·' : lum < 90 ? '░' : lum < 180 ? '▒' : '█';
      }
      grid.push(row);
    }
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      const lum = (r + g + b) / 3;
      sum += lum;
      if (lum < 32) dark++;
      if (lum > 225) light++;
      if (g > 150 && r < 120 && b > 100 && b < 220 && g > r + 60 && g > b + 20) mint++; // #3DDC97-ish
      if (r > 170 && g < 120 && b < 120) red++;
    }
    const n = d.length / 4;
    return {
      size: img.width + 'x' + img.height,
      meanLum: (sum / n).toFixed(0),
      dark: ((dark / n) * 100).toFixed(0) + '%',
      light: ((light / n) * 100).toFixed(1) + '%',
      mint: ((mint / n) * 100).toFixed(2) + '%',
      red: ((red / n) * 100).toFixed(2) + '%',
      grid: grid.join('\n'),
    };
  }, b64(path.join(PLATES, f)));
  console.log(`\n■ ${f}  ${stats.size}  lum=${stats.meanLum}  dark=${stats.dark} light=${stats.light} mint=${stats.mint} red=${stats.red}`);
  console.log(stats.grid);
}
await browser.close();
