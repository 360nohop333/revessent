// The cursor. Human-ish: bezier arcs between targets, fast launch and
// long deceleration, a faint settle, micro-drift while idle, a press
// dip + ripple on click. Coordinates are in PLATE space, so it stays
// glued to UI points while the camera moves.
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { easeCursor } from '../kit';
import { useScreenScale } from './Plate';

export type CursorPoint = { f: number; x: number; y: number };
export type ClickPoint = { f: number };

const ARROW =
  'M7 2.6 L7 20.4 L11.5 16.2 L14.3 22.4 L17 21.2 L14.2 15.1 L20.2 14.9 Z';

export const Cursor: React.FC<{
  points: CursorPoint[]; // first point = entry position, then targets
  clicks: ClickPoint[];
  appear?: number; // frame the cursor fades in
  size?: number;
}> = ({ points, clicks, appear = 0, size = 34 }) => {
  const frame = useCurrentFrame();
  const k = 1 / useScreenScale(); // keep on-screen size constant under camera zoom
  if (points.length === 0) return null;

  // position: walk segments
  let x = points[0].x, y = points[0].y;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    if (frame >= b.f) { x = b.x; y = b.y; continue; }
    if (frame > a.f) {
      const t = (frame - a.f) / Math.max(1, b.f - a.f);
      const e = easeCursor(t);
      // quadratic bezier arc, control point offset perpendicular
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const dx = b.x - a.x, dy = b.y - a.y;
      const len = Math.hypot(dx, dy) || 1;
      const bow = Math.min(90, len * 0.14) * (i % 2 === 0 ? 1 : -1);
      const cx = mx + (-dy / len) * bow, cy = my + (dx / len) * bow;
      const u = 1 - e;
      x = u * u * a.x + 2 * u * e * cx + e * e * b.x;
      y = u * u * a.y + 2 * u * e * cy + e * e * b.y;
    }
    break;
  }

  // idle micro-drift (also faintly present mid-move)
  x += Math.sin(frame * 0.7 + 1.3) * 1.1;
  y += Math.cos(frame * 0.9) * 0.9;

  // nearest click state
  const click = clicks.find((c) => frame >= c.f && frame < c.f + 11);
  const dip = click
    ? interpolate(frame, [click.f, click.f + 2, click.f + 5], [1, 0.78, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' })
    : 1;
  const ring = click ? interpolate(frame, [click.f, click.f + 10], [0, 1], { extrapolateRight: 'clamp' }) : 1;
  const ringOpacity = click ? Math.sin(Math.min(1, ring) * Math.PI) * 0.5 : 0;

  const opacity = interpolate(frame, [appear, appear + 5], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <div style={{ position: 'absolute', left: x, top: y, opacity, pointerEvents: 'none', transform: `scale(${k})`, transformOrigin: '0 0' }}>
      {click ? (
        <div
          style={{
            position: 'absolute', left: -23, top: -23, width: 46, height: 46, borderRadius: 999,
            border: '2px solid rgba(61,220,151,0.9)', opacity: ringOpacity,
            transform: `scale(${0.4 + ring * 1.1})`,
          }}
        />
      ) : null}
      <svg width={size} height={size * 0.94} viewBox="0 0 24 23" style={{ transform: `scale(${dip})`, transformOrigin: '4px 2px', filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.55))' }}>
        <path d={ARROW} fill="#ffffff" stroke="rgba(10,12,16,0.85)" strokeWidth="1.4" strokeLinejoin="round" />
      </svg>
    </div>
  );
};
