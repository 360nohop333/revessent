import { createRequire } from 'node:module';
import { Config } from '@remotion/cli/config';
import fs from 'node:fs';
import path from 'node:path';

Config.setPublicDir(path.resolve('public'));
Config.setVideoImageFormat('jpeg');
Config.setOverwriteOutput(true);

// The sandbox can't reach Remotion's Chrome-download CDN — use the
// self-contained @sparticuz/chromium build (same one the plate capture
// uses). Needs /tmp/chromium (run `node capture/capture.mjs` once, or
// inflate below) + its NSS libs on LD_LIBRARY_PATH.
if (!fs.existsSync('/tmp/chromium')) {
  // lazy inflate via the package's own code
  const { createRequire } = require('node:module');
  const { inflate } = createRequire(import.meta.url)('@sparticuz/chromium');
  ['chromium.br', 'fonts.tar.br', 'swiftshader.tar.br', 'al2023.tar.br'].forEach((f) => {
    inflate(path.join(process.cwd(), 'node_modules/@sparticuz/chromium/bin', f)).catch(() => {});
  });
}
if (fs.existsSync('/tmp/chromium')) {
  Config.setBrowserExecutable('/tmp/chromium');
  process.env.LD_LIBRARY_PATH = ['/tmp/al2023/lib', process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  process.env.FONTCONFIG_PATH = '/tmp/fonts';
}
import path from 'node:path';
