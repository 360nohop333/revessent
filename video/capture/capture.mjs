#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Revessent ad — REAL-UI plate capture.
//
// Serves the actual product from this repo, renders it in headless
// Chromium, and intercepts only the network edges that need control:
//   · the Supabase CDN script → a tiny local shim (session from
//     localStorage — the SDK is never visible in the UI)
//   · Google Fonts CSS/fonts → the exact woff2 files, served locally
//     (@fontsource/inter + ibm-plex-mono — same faces as production)
//   · /api/* → the controlled demo state in demo-data.mjs
// Every pixel of product UI is the real app, really rendered.
//
// Output: video/src/plates/*.png (3200×2000 plates, DPR 2)
// Usage:  node capture/capture.mjs [--only shot1,shot2] [--out dir]
// ═══════════════════════════════════════════════════════════════════
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const puppeteer = require('puppeteer-core');
const { inflate } = require('@sparticuz/chromium');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const PLATES = path.resolve(__dirname, '../src/plates');
const PORT = 8123;

import { CASES, DRAFT, caseResponse, dashboardData, digestsData, membersData, meData } from './demo-data.mjs';

// ── shared demo state (flips as the story beats play) ─────────────
const state = { dashVersion: 1, c1Succeeded: false, c2NoteSent: false };

// ── fonts: same faces production loads, served from npm ───────────
const fontWeights = { inter: [300, 400, 500, 600, 700], 'ibm-plex-mono': [400, 500, 600] };
function fontFile(family, weight) {
  return path.join(REPO, 'video/node_modules/@fontsource', family, 'files', `${family}-latin-${weight}-normal.woff2`);
}
function fontsCss() {
  let css = '';
  for (const w of fontWeights.inter) {
    css += `@font-face{font-family:'Inter';font-style:normal;font-weight:${w};font-display:swap;src:url(https://fonts.gstatic.com/s/inter/rv-${w}.woff2) format('woff2');}\n`;
  }
  for (const w of fontWeights['ibm-plex-mono']) {
    css += `@font-face{font-family:'IBM Plex Mono';font-style:normal;font-weight:${w};font-display:swap;src:url(https://fonts.gstatic.com/s/plex/rv-${w}.woff2) format('woff2');}\n`;
  }
  return css;
}

// ── supabase shim: exactly the surface the app touches ────────────
const SUPABASE_SHIM = `
window.supabase = { createClient: function () {
  var KEY = 'sb-zujmouzzqiovgbnanrvv-auth-token';
  function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { return null; } }
  return { auth: {
    getSession: function () { return Promise.resolve({ data: { session: read() }, error: null }); },
    refreshSession: function () { return Promise.resolve({ data: { session: read() }, error: null }); },
    getUser: function () { var s = read(); return Promise.resolve({ data: { user: s && s.user }, error: null }); },
    signOut: function () { try { localStorage.removeItem(KEY); } catch (_) {} return Promise.resolve({ error: null }); },
    onAuthStateChange: function () { return { data: { subscription: { unsubscribe: function () {} } } }; },
  } };
} };`;

// ── fake (locally-trusted) Supabase session ────────────────────────
function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
const fakeJwt = [
  b64url({ alg: 'HS256', typ: 'JWT' }),
  b64url({
    iss: 'https://zujmouzzqiovgbnanrvv.supabase.co/auth/v1',
    sub: '00000000-0000-0000-0000-000000000001',
    aud: 'authenticated', role: 'authenticated',
    email: 'founder@bloomcoffee.club',
    exp: 2000000000, iat: 1730000000,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    created_at: '2025-06-01T00:00:00.000Z',
    is_anonymous: false,
  }),
  'capture',
].join('.');
const SESSION = {
  access_token: fakeJwt,
  refresh_token: 'capture-refresh',
  token_type: 'bearer',
  expires_in: 100000000,
  expires_at: 2000000000,
  user: {
    id: '00000000-0000-0000-0000-000000000001',
    email: 'founder@bloomcoffee.club',
    aud: 'authenticated', role: 'authenticated',
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    email_confirmed_at: '2025-06-01T00:00:00.000Z',
    phone: '',
    created_at: '2025-06-01T00:00:00.000Z',
    is_anonymous: false,
  },
};

// ── static server for the real repo ────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2' };
function startServer() {
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let file = path.normalize(path.join(REPO, urlPath));
      if (!file.startsWith(REPO)) { res.writeHead(403); return res.end(); }
      if (urlPath === '/' || urlPath === '') file = path.join(REPO, 'index.html');
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('not found'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    } catch (e) { res.writeHead(500); res.end(); }
  });
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

// ── request interception: the controlled edges ─────────────────────
function jsonBody(x) { return JSON.stringify(x); }
async function handleRequest(req, state) {
  const url = req.url();
  const u = new URL(url);
  const host = u.hostname;
  const p = u.pathname;

  const reply = (status, body, contentType) =>
    req.respond({ status, contentType: contentType || 'application/json', body });
  const replyCors = (status, body, contentType) =>
    req.respond({ status, contentType, body, headers: { 'Access-Control-Allow-Origin': '*' } });

  try {
    if (host === 'cdn.jsdelivr.net' && p.includes('supabase')) {
      return replyCors(200, SUPABASE_SHIM, 'text/javascript');
    }
    if (host === 'fonts.googleapis.com') {
      return replyCors(200, fontsCss(), 'text/css');
    }
    if (host === 'fonts.gstatic.com') {
      const m = p.match(/rv-(\d+)\.woff2$/);
      if (!m) return replyCors(404, '', 'font/woff2');
      const family = p.includes('/plex/') ? 'ibm-plex-mono' : 'inter';
      const file = fontFile(family, m[1]);
      if (!fs.existsSync(file)) return replyCors(404, '', 'font/woff2');
      return replyCors(200, fs.readFileSync(file), 'font/woff2');
    }
    if (host === '127.0.0.1' || host === 'localhost') {
      if (p === '/api/dashboard-data') return reply(200, jsonBody(dashboardData(state.dashVersion)));
      if (p === '/api/recovery/case') {
        const caseId = u.searchParams.get('caseId') || u.searchParams.get('id');
        const data = caseResponse(caseId, state);
        if (!data) return reply(404, jsonBody({ error: 'Not found.' }));
        return reply(200, jsonBody(data));
      }
      if (p === '/api/recovery/retry' && req.method() === 'POST') {
        state.c1Succeeded = true;
        return reply(200, jsonBody({ ok: true }));
      }
      if (p === '/api/recovery/send-note' && req.method() === 'POST') {
        const body = JSON.parse(req.postData() || '{}');
        if (body.autoSend === false) return reply(200, jsonBody({ noteId: DRAFT.noteId, subject: DRAFT.subject, body: DRAFT.body }));
        state.c2NoteSent = true;
        return reply(200, jsonBody({ ok: true }));
      }
      if (p === '/api/digests') return reply(200, jsonBody(digestsData()));
      if (p === '/api/members') return reply(200, jsonBody(membersData()));
      if (p === '/api/me') return reply(200, jsonBody(meData()));
      // everything else (real static files) → the local server
    }
    return req.continue();
  } catch (e) {
    return req.continue();
  }
}

// ── page helpers ───────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function openPage(browser, route) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 2 });
  if (process.env.CAPTURE_DEBUG) {
    page.on('console', (m) => console.log('   [console]', m.type(), m.text().slice(0, 160)));
    page.on('pageerror', (e) => console.log('   [pageerror]', String(e).slice(0, 200)));
    page.on('response', (r) => { if (r.url().includes('/api/')) console.log('   [api]', r.status(), r.url().slice(0, 90)); });
  }
  await page.setRequestInterception(true);
  page.on('request', (req) => handleRequest(req, state));
  await page.evaluateOnNewDocument((session) => {
    try {
      localStorage.setItem('sb-zujmouzzqiovgbnanrvv-auth-token', JSON.stringify(session));
      localStorage.setItem('rv.theme', 'amoled');
    } catch (_) {}
  }, SESSION);
  await page.goto(`http://127.0.0.1:${PORT}${route}`, { waitUntil: 'networkidle0', timeout: 45000 });
  return page;
}

async function settle(page, extra = 1400) {
  try { await page.evaluate(() => document.fonts.ready); } catch (_) {}
  await page
    .waitForFunction(() => !document.querySelector('.rv:not(.in)'), { timeout: 5000 })
    .catch(() => {});
  await sleep(extra);
}

async function shot(page, name) {
  const file = path.join(PLATES, `${name}.png`);
  await page.screenshot({ path: file });
  console.log(`  ✎ ${name}.png`);
}

// DOM truth probe — logs what the real UI actually shows, per plate,
// and records element geometry (CSS px in the 1600×1000 viewport) that
// the Remotion timeline uses for cursor targets and camera framing.
const GEOMETRY_FILE = path.join(PLATES, 'geometry.json');
let GEOMETRY = { viewport: { width: 1600, height: 1000 } };
try { Object.assign(GEOMETRY, JSON.parse(fs.readFileSync(GEOMETRY_FILE, 'utf8'))); } catch (_) {}
const GEOM_SELECTORS = {
  'dash-hero': ['#revRecoveredVal', '#revRiskVal', '#recoveryRateLbl', '#queue', '.kpi', '#pilot', '#chart'],
  'dash-hero-v2': ['#revRecoveredVal', '#revRiskVal', '#recoveryRateLbl'],
  'dash-queue': ['#queue', '#queue tbody tr', '#approveAllBtn'],
  'case-before': ['#caseHero', '#retryBtn', '#draftBtn', '#timeline'],
  'case-after': ['#caseHero', '#retryBtn', '#toast', '.sb-brand'],
  'case-draft': ['#caseHero', '#draftBtn', '#draftBox', '#draftSubject', '#sendDraftBtn', '#toast'],
  'case-sent': ['#caseHero', '#sendDraftBtn', '#toast', '#timeline .event'],
  digest: ['#digestList .event', '.hero.card'],
  members: ['#membersBody tr', '.hero.card'],
  'landing-hero': ['.hero-copy h1', '.hw', '.btn-pri'],
};
const TEXT_SELECTORS = {
  'dash-hero': ['#revRecoveredVal', '#revRiskVal', '#recoveryRateLbl', '#pilotDays', '#qbadge'],
  'dash-hero-v2': ['#revRecoveredVal', '#revRiskVal', '#recoveryRateLbl', '#qbadge'],
  'dash-queue': ['#qbadge', '#queue tbody tr td:nth-child(1)'],
  'case-before': ['#caseHero h1', '#caseHero .sub'],
  'case-after': ['#caseHero h1', '#caseHero .sub', '#toast'],
  'case-draft': ['#caseHero h1', '#draftSubject', '#toast'],
  'case-sent': ['#caseHero h1', '#toast'],
  digest: ['#digestList .event h3', '#digestList .event .meta span'],
  members: ['#membersBody tr td:nth-child(1)'],
};
async function probe(page, name) {
  const geom = {};
  for (const sel of GEOM_SELECTORS[name] || []) {
    try {
      const handles = await page.$$(sel);
      const list = [];
      for (const h of handles.slice(0, 6)) {
        const box = await h.boundingBox();
        if (box) list.push({ x: Math.round(box.x), y: Math.round(box.y), w: Math.round(box.width), h: Math.round(box.height) });
      }
      if (list.length) geom[sel] = list;
    } catch (_) {}
  }
  const text = {};
  for (const sel of TEXT_SELECTORS[name] || []) {
    try {
      text[sel] = (await page.$eval(sel, (el) => el.textContent).catch(() => null) || '')
        .trim().replace(/\s+/g, ' ').slice(0, 70);
      if (sel === '#draftSubject') text[sel] = await page.$eval(sel, (el) => el.value);
    } catch (_) { text[sel] = null; }
  }
  const meta = await page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    interLoaded: document.fonts.check('600 16px Inter'),
    monoLoaded: document.fonts.check('500 12px "IBM Plex Mono"'),
    theme: document.documentElement.dataset.theme || null,
  }));
  GEOMETRY[name] = { geom, text, meta };
  fs.writeFileSync(path.join(PLATES, 'geometry.json'), JSON.stringify(GEOMETRY, null, 2));
  console.log(`  ⌕ ${name}: fonts(I:${meta.interLoaded ? '✓' : '✗'} M:${meta.monoLoaded ? '✓' : '✗'}) scroll=${meta.scrollY} ${JSON.stringify(text)}`);
}

// ── the shot list — every plate is the real UI at a story beat ────
const SHOTS = {
  'landing-hero': async (b) => {
    const p = await openPage(b, '/index.html');
    await settle(p, 2200);
    await shot(p, 'landing-hero');
    await probe(p, 'landing-hero');
    await p.close();
  },
  'dash-hero': async (b) => {
    const p = await openPage(b, '/dashboard.html');
    await settle(p);
    await shot(p, 'dash-hero');
    await probe(p, 'dash-hero');
    await p.close();
  },
  'dash-queue': async (b) => {
    const p = await openPage(b, '/dashboard.html');
    await settle(p, 600);
    await p.evaluate(() => {
      // html{scroll-behavior:smooth} makes scrollIntoView async — set scrollTop directly
      const top = document.querySelector('#queue').getBoundingClientRect().top + window.scrollY;
      document.documentElement.scrollTop = Math.max(0, top - 64);
    });
    await p.evaluate(() => document.querySelectorAll('.rv').forEach((el) => el.classList.add('in')));
    await settle(p, 1600);
    await shot(p, 'dash-queue');
    await probe(p, 'dash-queue');
    await p.close();
  },
  'dash-hero-v2': async (b) => {
    state.dashVersion = 2;
    const p = await openPage(b, '/dashboard.html');
    await settle(p);
    await shot(p, 'dash-hero-v2');
    await probe(p, 'dash-hero-v2');
    await p.close();
  },
  'case-before': async (b) => {
    const p = await openPage(b, '/case-detail.html?case=c1');
    await settle(p);
    await shot(p, 'case-before');
    await probe(p, 'case-before');
    return p;
  },
  'case-after': async (b) => {
    const p = await openPage(b, '/case-detail.html?case=c1');
    await settle(p);
    await p.click('#retryBtn');
    await p.waitForFunction(
      () => Array.from(document.querySelectorAll('#caseHero .pill, #caseHero [class*=pill]')).some((el) => /succeeded/i.test(el.textContent)),
      { timeout: 8000 }
    );
    await sleep(350);
    await shot(p, 'case-after');
    await probe(p, 'case-after');
    await p.close();
  },
  'case-draft': async (b) => {
    const p = await openPage(b, '/case-detail.html?case=c2');
    await settle(p);
    await p.click('#draftBtn');
    await p.waitForFunction(
      () => !document.querySelector('#draftBox')?.hidden && document.querySelector('#draftSubject')?.value.length > 0,
      { timeout: 8000 }
    );
    await sleep(500);
    await shot(p, 'case-draft');
    await probe(p, 'case-draft');
    return p;
  },
  'case-sent': async (b) => {
    const p = await openPage(b, '/case-detail.html?case=c2');
    await settle(p);
    await p.click('#draftBtn');
    await p.waitForFunction(
      () => !document.querySelector('#draftBox')?.hidden && document.querySelector('#draftSubject')?.value.length > 0,
      { timeout: 8000 }
    );
    await p.click('#sendDraftBtn');
    await p.waitForFunction(
      () => Array.from(document.querySelectorAll('#timeline .event')).some((el) => /sent/i.test(el.textContent)) && /sent/i.test(document.querySelector('#toast')?.textContent || ''),
      { timeout: 8000 }
    );
    await sleep(250);
    await shot(p, 'case-sent');
    await probe(p, 'case-sent');
    await p.close();
  },
  digest: async (b) => {
    const p = await openPage(b, '/weekly-digest.html');
    await settle(p);
    await shot(p, 'digest');
    await probe(p, 'digest');
    await p.close();
  },
  members: async (b) => {
    const p = await openPage(b, '/members.html');
    await settle(p);
    await shot(p, 'members');
    await probe(p, 'members');
    await p.close();
  },
};

// ── main ───────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const onlyArg = args.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.split('=')[1].split(',') : null;

  fs.mkdirSync(PLATES, { recursive: true });

  // 1. browser: @sparticuz/chromium, fully self-contained from npm
  if (!fs.existsSync('/tmp/chromium')) {
    console.log('· inflating chromium + fonts + al2023 libs…');
    await inflate(path.join(REPO, 'video/node_modules/@sparticuz/chromium/bin/chromium.br'));
    await inflate(path.join(REPO, 'video/node_modules/@sparticuz/chromium/bin/fonts.tar.br'));
    await inflate(path.join(REPO, 'video/node_modules/@sparticuz/chromium/bin/swiftshader.tar.br'));
    await inflate(path.join(REPO, 'video/node_modules/@sparticuz/chromium/bin/al2023.tar.br'));
  }

  // 2. the real app, served locally
  const server = await startServer();
  console.log(`· serving ${REPO} on 127.0.0.1:${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: '/tmp/chromium',
    headless: 'shell',
    env: { ...process.env, LD_LIBRARY_PATH: '/tmp/al2023/lib', FONTCONFIG_PATH: '/tmp/fonts' },
    args: [
      '--no-sandbox', '--no-zygote', '--disable-setuid-sandbox',
      '--font-render-hinting=none', '--force-color-profile=srgb',
      '--hide-scrollbars', '--disable-dev-shm-usage', '--disable-gpu',
    ],
  });
  console.log('· chromium up — capturing plates\n');

  const order = ['landing-hero', 'dash-hero', 'dash-queue', 'case-before', 'case-after', 'case-draft', 'case-sent', 'digest', 'members', 'dash-hero-v2'];
  for (const name of order) {
    if (only && !only.includes(name)) continue;
    const t = Date.now();
    try {
      await SHOTS[name](browser);
      console.log(`  ✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
    } catch (e) {
      console.error(`  ✗ ${name}: ${e.message.split('\n')[0]}`);
    }
  }

  await browser.close();
  server.close();
  console.log('\n· done — plates in video/src/plates/');
}

main().catch((e) => { console.error(e); process.exit(1); });
