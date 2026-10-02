// ═══════════════════════════════════════════════════════════════════
// Revessent ad — shared kit: brand tokens, easing, camera math,
// format layouts, geometry from the real-UI plate capture.
// ═══════════════════════════════════════════════════════════════════
import geometry from '../public/plates/geometry.json';

export const BRAND = {
  page: '#000000',
  text: '#F2F5F7',
  textDim: '#C3CBD6',
  muted: '#8B94A3',
  mint: '#3DDC97',
  mintInk: '#8CF0C4',
  neg: '#F87B6C',
  warn: '#F5B84C',
  info: '#6BB8FF',
  edge: 'rgba(255,255,255,0.10)',
};

export const PLATE = { w: 1600, h: 1000 }; // plates were captured at 1600×1000 (CSS px)

// ── easing ─────────────────────────────────────────────────────────
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
export const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
export const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// human cursor: quick launch, long decelerate, faint settle
export const easeCursor = (t: number) => {
  const e = 1 - Math.pow(1 - t, 4.2);
  return e - Math.sin(Math.min(1, t) * Math.PI) * 0.035; // slight undershoot mid-flight
};

// ── camera ─────────────────────────────────────────────────────────
// cam = { x, y, zoom } — a point in plate space, shown at the center
// of the view; zoom 1 = plate width exactly fills the view width.
export type Cam = { x: number; y: number; zoom: number };
export const lerpCam = (a: Cam, b: Cam, t: number): Cam => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
  zoom: a.zoom + (b.zoom - a.zoom) * t,
});

// plate → view transform (applies inside an absolutely-positioned view box)
// zoom 1 = the plate just covers the view (same framing across formats).
export function plateTransform(cam: Cam, view: { x: number; y: number; w: number; h: number }) {
  const cover = Math.max(view.w / PLATE.w, view.h / PLATE.h);
  const s = cover * cam.zoom;
  // keep the visible region inside the plate — no black gutters,
  // regardless of format aspect
  const halfW = view.w / (2 * s);
  const halfH = view.h / (2 * s);
  const cx = Math.min(Math.max(cam.x, halfW), PLATE.w - halfW);
  const cy = Math.min(Math.max(cam.y, halfH), PLATE.h - halfH);
  const px = view.x + view.w / 2 - cx * s;
  const py = view.y + view.h / 2 - cy * s;
  return {
    left: 0, top: 0, width: PLATE.w, height: PLATE.h,
    transform: `translate(${px}px, ${py}px) scale(${s})`,
    transformOrigin: '0 0',
  };
}

// ── formats ────────────────────────────────────────────────────────
export type FormatId = '16x9' | '9x16' | '1x1';
export type Format = {
  id: FormatId;
  w: number; h: number;
  plateView: { x: number; y: number; w: number; h: number };
  caption: { x: number; y: number; w: number; align: 'left' | 'center'; size: number };
  statement: { y: number; size: number };
  hook: { y: number; size: number; gap: number };
  brand: { markY: number; headY: number; ctaY: number; size: number };
  chrome: boolean;
};

export const FORMATS: Record<FormatId, Format> = {
  '16x9': {
    id: '16x9', w: 1920, h: 1080,
    plateView: { x: 0, y: 0, w: 1920, h: 1080 },
    caption: { x: 110, y: 872, w: 900, align: 'left', size: 44 },
    statement: { y: 640, size: 68 },
    hook: { y: 350, size: 30, gap: 26 },
    brand: { markY: 380, headY: 520, ctaY: 700, size: 58 },
    chrome: true,
  },
  '9x16': {
    id: '9x16', w: 1080, h: 1920,
    plateView: { x: 0, y: 580, w: 1080, h: 760 },
    caption: { x: 90, y: 1450, w: 900, align: 'center', size: 46 },
    statement: { y: 1060, size: 62 },
    hook: { y: 620, size: 30, gap: 26 },
    brand: { markY: 700, headY: 850, ctaY: 1080, size: 58 },
    chrome: true,
  },
  '1x1': {
    id: '1x1', w: 1080, h: 1080,
    plateView: { x: 0, y: 170, w: 1080, h: 675 },
    caption: { x: 90, y: 912, w: 900, align: 'center', size: 42 },
    statement: { y: 560, size: 58 },
    hook: { y: 400, size: 28, gap: 24 },
    brand: { markY: 360, headY: 490, ctaY: 660, size: 52 },
    chrome: true,
  },
};

// ── real-UI geometry (from capture/geometry.json — CSS px in the plate) ──
type Box = { x: number; y: number; w: number; h: number };
const g = geometry as unknown as Record<string, { geom: Record<string, Box[]> }>;
const box = (shot: string, sel: string, i = 0): Box => {
  const b = g[shot]?.geom?.[sel]?.[i];
  if (!b) throw new Error(`geometry missing: ${shot} ${sel}`);
  return b;
};
export const center = (b: Box): { x: number; y: number } => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

export const GEO = {
  kpiRecovered: box('dash-hero', '#revRecoveredVal'),
  kpiRisk: box('dash-hero', '#revRiskVal'),
  queueCard: box('dash-queue', '#queue'),
  queueRow1: box('dash-queue', '#queue tbody tr', 0),
  queueRow2: box('dash-queue', '#queue tbody tr', 1),
  caseHero: box('case-before', '#caseHero'),
  retryBtn: box('case-before', '#retryBtn'),
  draftBtn: box('case-draft', '#draftBtn'),
  draftBox: box('case-draft', '#draftBox'),
  sendDraftBtn: box('case-draft', '#sendDraftBtn'),
  timeline: box('case-sent', '#timeline .event', 0),
  digestCard: box('digest', '#digestList .event', 0),
  membersRow: box('members', '#membersBody tr', 0),
};

// handy centers for cursor targets / camera
export const PT = {
  kpiRecovered: center(GEO.kpiRecovered),
  kpiRisk: center(GEO.kpiRisk),
  queueRow1: center(GEO.queueRow1),
  retryBtn: center(GEO.retryBtn),
  draftBtn: center(GEO.draftBtn),
  draftBox: center(GEO.draftBox),
  sendDraftBtn: center(GEO.sendDraftBtn),
  dashboard: { x: 800, y: 480 },
};

// ── tiny helpers ───────────────────────────────────────────────────
export const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
export const pad2 = (n: number) => String(n).padStart(2, '0');
