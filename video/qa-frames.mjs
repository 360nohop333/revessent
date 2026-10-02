// Frame QA for rendered ads: extracts probe frames and checks them
// numerically — dark product frames, text coverage where captions/type
// should be, mint presence for brand/CTA, cursor visibility near
// expected points. Catches layout disasters without eyeballs.
import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { PNG } = require('pngjs');

const FF = 'node_modules/@remotion/compositor-linux-x64-gnu/ffmpeg';
const W = 480, H = Math.round(480 * 9 / 16);

const mp4 = process.argv[2];
const probes = JSON.parse(process.argv[3]); // [{f, name, checks:{...}}]

rmSync('out/qa', { recursive: true, force: true });
mkdirSync('out/qa', { recursive: true });

const stats = (png) => {
  const { width, height, data } = png;
  const px = (x, y) => {
    const i = (y * width + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  };
  return { width, height, px };
};

// region: [x0,y0,x1,y1] in fractions; returns {mean, dark, bright, mint, neg}
function region(s, r) {
  const x0 = Math.floor(r[0] * s.width), y0 = Math.floor(r[1] * s.height);
  const x1 = Math.ceil(r[2] * s.width), y1 = Math.ceil(r[3] * s.height);
  let n = 0, sum = 0, dark = 0, bright = 0, mint = 0, neg = 0, sat = 0;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) {
    const [R, G, B] = s.px(x, y);
    const l = 0.2126 * R + 0.7152 * G + 0.0722 * B;
    sum += l; n++;
    if (l < 24) dark++;
    if (l > 190) bright++;
    if (G > 120 && G > R * 1.5 && G > B * 1.3) mint++;
    if (R > 150 && R > G * 1.5 && R > B * 1.5) neg++;
    if (Math.max(R, G, B) - Math.min(R, G, B) > 40) sat++;
  }
  const k = 1 / n;
  return { mean: sum * k, dark: dark * k, bright: bright * k, mint: mint * k, neg: neg * k, sat: sat * k };
}

const out = [];
for (const p of probes) {
  const f = 'out/qa/' + p.name + '.png';
  const t = (p.f / 30).toFixed(3);
  execFileSync(FF, ['-y', '-loglevel', 'error', '-ss', t, '-i', mp4, '-frames:v', '1', '-vf', `scale=480:-1`, f], { stdio: 'ignore' });
  const buf = readdirSync('out/qa').length; // noop
  const png = PNG.sync.read((await import('node:fs')).readFileSync(f));
  const s = stats(png);
  const r = {};
  for (const [name, rect] of Object.entries(p.regions || {})) r[name] = region(s, rect);
  out.push({ frame: p.f, name: p.name, full: region(s, [0, 0, 1, 1]), ...r });
}
console.log(JSON.stringify(out, null, 1));
