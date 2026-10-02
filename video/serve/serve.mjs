// Tiny static server with HTTP Range support (browsers need Range
// to seek/play MP4s properly). Serves renders/ + the player page.
import { createServer } from 'node:http';
import { createReadStream, statSync, existsSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';

const ROOT = new URL('../renders', import.meta.url).pathname;
const SERVE = new URL('.', import.meta.url).pathname; // index.html lives here
const PORT = 8080;

const TYPES = { '.mp4': 'video/mp4', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };

createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'content-type': TYPES['.html'] });
    createReadStream(join(SERVE, 'index.html')).pipe(res);
    return;
  }
  const base = url.startsWith('/serve/') ? SERVE : ROOT;
  const rel = normalize(url.replace(/^\/+/, ''));
  if (rel.includes('..')) { res.writeHead(403); res.end(); return; }
  const file = join(base, rel);
  if (!existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  const { size } = statSync(file);
  const type = TYPES[extname(file)] || 'application/octet-stream';
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    const start = m ? +m[1] : 0;
    const end = m && m[2] ? Math.min(+m[2], size - 1) : size - 1;
    res.writeHead(206, {
      'content-type': type, 'content-range': `bytes ${start}-${end}/${size}`,
      'accept-ranges': 'bytes', 'content-length': end - start + 1,
    });
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size });
    createReadStream(file).pipe(res);
  }
}).listen(PORT, '0.0.0.0', () => console.log(`ad previews on :${PORT}`));
