// The brand frame: the real product, defocused; the wordmark exactly
// as the app renders it (lowercase + mint period); the actual
// positioning line from the landing page; a CTA in the product's own
// primary-button style.
import React from 'react';
import { Img, interpolate, useCurrentFrame, useVideoConfig, staticFile } from 'remotion';
import { BRAND, clamp01, easeOutQuint } from '../kit';
import type { Format } from '../kit';

export const BrandEnd: React.FC<{ format: Format; from: number; bg: string }> = ({ format: fmt, from, bg }) => {
  const frame = useCurrentFrame();
  const { width } = useVideoConfig();
  const f = frame + 0; // sequence-local

  const bgBlurIn = clamp01(f / 14);
  const markT = clamp01((f - 12) / 12);
  const headT = clamp01((f - 30) / 14);
  const ctaT = clamp01((f - 52) / 12);
  const subT = clamp01((f - 64) / 12);

  const e = easeOutQuint;
  const centerX = width / 2;
  const dotPulse = 1 + Math.sin(Math.max(0, f - 30) * 0.09) * 0.06;

  return (
    <div style={{ position: 'absolute', inset: 0, background: BRAND.page, overflow: 'hidden' }}>
      <Img
        src={staticFile(bg)}
        style={{
          position: 'absolute', width: 1600, height: 1000,
          left: centerX - 800 * 1.22, top: fmt.h * 0.5 - 500 * 1.22,
          transform: 'scale(1.22)',
          filter: `blur(${22 + (1 - bgBlurIn) * 18}px) brightness(0.4) saturate(0.9)`,
          opacity: 0.9 * bgBlurIn,
        }}
      />
      <div style={{ position: 'absolute', inset: 0, background: 'radial-gradient(90% 70% at 50% 40%, rgba(0,0,0,0.25), rgba(0,0,0,0.72) 85%)' }} />

      {/* brand mark + wordmark — exactly as the app renders them */}
      <div
        style={{
          position: 'absolute', left: 0, right: 0, top: fmt.brand.markY - fmt.brand.size * 1.1,
          display: 'flex', justifyContent: 'center', alignItems: 'center', gap: fmt.brand.size * 0.3,
          opacity: e(markT), transform: `translateY(${(1 - e(markT)) * 26}px)`,
          filter: `blur(${(1 - e(markT)) * 10}px)`,
        }}
      >
        <svg width={fmt.brand.size * 1.05} height={fmt.brand.size * 1.05} viewBox="0 0 28 28" aria-hidden="true">
          <defs>
            <linearGradient id="rmg" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#fff7e6" />
              <stop offset="1" stopColor="#f0e2c6" />
            </linearGradient>
          </defs>
          <rect x="1.2" y="1.2" width="25.6" height="25.6" rx="8" fill="url(#rmg)" />
          <rect x="1.2" y="1.2" width="25.6" height="25.6" rx="8" fill="none" stroke="#fff" strokeOpacity=".6" />
          <path d="M7 18.5h2.6l1.9-6 2.6 8 2.2-7 2 5H21" fill="none" stroke="#8a5f33" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div
          style={{
            fontFamily: 'Inter, sans-serif', fontWeight: 700, fontSize: fmt.brand.size * 1.5,
            letterSpacing: '-0.035em', color: BRAND.text, lineHeight: 1,
          }}
        >
          revessent
          <span style={{ color: BRAND.mint, display: 'inline-block', transform: `scale(${dotPulse})`, transformOrigin: '50% 70%' }}>.</span>
        </div>
      </div>

      {/* positioning line — verbatim from the landing hero */}
      <div
        style={{
          position: 'absolute', left: fmt.w * 0.1, right: fmt.w * 0.1, top: fmt.brand.headY, textAlign: 'center',
          fontFamily: 'Inter, sans-serif', fontWeight: 600, fontSize: fmt.brand.size * 0.52,
          lineHeight: 1.22, letterSpacing: '-0.018em', color: BRAND.textDim,
          opacity: e(headT), transform: `translateY(${(1 - e(headT)) * 18}px)`,
          filter: `blur(${(1 - e(headT)) * 7}px)`,
        }}
      >
        Never lose another member
        <br />to a failed card.
      </div>

      {/* CTA — the product's primary-button treatment */}
      <div
        style={{
          position: 'absolute', left: 0, right: 0, top: fmt.brand.ctaY,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 20,
          opacity: e(ctaT), transform: `translateY(${(1 - e(ctaT)) * 14}px) scale(${0.96 + e(ctaT) * 0.04})`,
        }}
      >
        <div
          style={{
            fontFamily: 'Inter, sans-serif', fontWeight: 640, fontSize: fmt.brand.size * 0.4,
            color: '#00140C', background: BRAND.mint, borderRadius: 999,
            padding: `${fmt.brand.size * 0.24}px ${fmt.brand.size * 0.72}px`,
            letterSpacing: '-0.01em',
            boxShadow: `0 0 ${20 + e(ctaT) * 26}px rgba(61,220,151,${0.16 + e(ctaT) * 0.2}), inset 0 1px 0 rgba(255,255,255,0.5)`,
          }}
        >
          Start your free pilot
        </div>
        <div
          style={{
            fontFamily: "'IBM Plex Mono', monospace", fontSize: fmt.brand.size * 0.21, fontWeight: 500,
            letterSpacing: '0.16em', textTransform: 'uppercase', color: BRAND.muted,
            opacity: e(subT),
          }}
        >
          Razorpay-native · 14-day pilot · PCI-conscious
        </div>
      </div>
    </div>
  );
};

// Cover panel that hides the (already-open) draft box until the moment
// the cursor clicks "Draft recovery email" — then wipes away so the
// real UI content reveals exactly on the action.
export const DraftCover: React.FC<{
  box: { x: number; y: number; w: number; h: number };
  revealAt: number;
  dur?: number;
}> = ({ box, revealAt, dur = 16 }) => {
  const frame = useCurrentFrame();
  const t = clamp01((frame - revealAt) / dur);
  if (t >= 1) return null;
  const e = easeOutQuint(t);
  return (
    <div
      style={{
        position: 'absolute', left: box.x - 8, top: box.y - 8,
        width: box.w + 16, height: (box.h + 16) * (1 - e),
        overflow: 'hidden', borderRadius: 16,
        background: '#04060a', border: '1px solid rgba(255,255,255,0.05)',
        opacity: 1 - Math.max(0, t - 0.75) * 4,
      }}
    />
  );
};
