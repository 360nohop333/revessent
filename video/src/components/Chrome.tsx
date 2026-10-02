// Minimal, honest browser chrome — establishes "this is the real
// product, in a browser" during the reveal, then collapses away as we
// cut inside. URL shown is the project's real production domain.
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { clamp01 } from '../kit';

export const BrowserChrome: React.FC<{
  url: string;
  title: string;
  collapseAt?: number; // frame the bar collapses (we enter the app)
  height?: number;
}> = ({ url, title, collapseAt, height = 46 }) => {
  const frame = useCurrentFrame();
  const collapse = collapseAt !== undefined ? clamp01((frame - collapseAt) / 9) : 0;
  const barH = height * (1 - collapse);

  return (
    <div style={{ position: 'absolute', left: 0, right: 0, top: 0, height: barH, overflow: 'hidden', background: '#0a0c10', borderBottom: `1px solid rgba(255,255,255,0.07)`, display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px', zIndex: 5, opacity: 1 - collapse * 0.4 }}>
      <div style={{ display: 'flex', gap: 7, flex: 'none' }}>
        {['#2b3138', '#2b3138', '#2b3138'].map((c, i) => (
          <span key={i} style={{ width: 11, height: 11, borderRadius: 999, background: c }} />
        ))}
      </div>
      <div
        style={{
          flex: 'none', maxWidth: '46%', display: 'flex', alignItems: 'center', gap: 8,
          background: 'rgba(255,255,255,0.055)', border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 8, padding: '4px 12px',
          fontFamily: "'IBM Plex Mono', monospace", fontSize: 13, color: '#9aa3af', whiteSpace: 'nowrap',
        }}
      >
        <svg width="9" height="11" viewBox="0 0 9 11" fill="none">
          <rect x="0.5" y="4.5" width="8" height="6" rx="1.5" stroke="#9aa3af" />
          <path d="M2.5 4.5V3a2 2 0 0 1 4 0v1.5" stroke="#9aa3af" />
        </svg>
        {url}
      </div>
      <div style={{ fontFamily: 'Inter, sans-serif', fontSize: 12.5, color: '#6b7482', whiteSpace: 'nowrap', opacity: 1 - collapse }}>
        {title}
      </div>
    </div>
  );
};
