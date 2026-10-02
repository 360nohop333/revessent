// Kinetic type: staggered word reveals (rise + de-blur), a mono kicker
// chip, and the opening decline-log lines. All in the product's own
// type system — Inter for statements, IBM Plex Mono for system voice.
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { BRAND, clamp01, easeOutQuint } from '../kit';

const Word: React.FC<{ text: string; i: number; at: number; size: number; color: string; weight: number }> = ({
  text, i, at, size, color, weight,
}) => {
  const frame = useCurrentFrame();
  const t = clamp01((frame - at - i * 2.1) / 9);
  const e = easeOutQuint(t);
  return (
    <span
      style={{
        display: 'inline-block',
        marginRight: size * 0.26,
        color, fontSize: size, fontWeight: weight, lineHeight: 1.12,
        letterSpacing: '-0.022em',
        opacity: t,
        transform: `translateY(${(1 - e) * size * 0.42}px)`,
        filter: `blur(${(1 - e) * 9}px)`,
      }}
    >
      {text}
    </span>
  );
};

export const Caption: React.FC<{
  text: string;
  at: number;
  kicker?: string;
  exit?: number;
  format: { caption: { x: number; y: number; w: number; align: 'left' | 'center'; size: number } };
  maxWidth?: number;
}> = ({ text, at, kicker, exit, format, maxWidth = 940 }) => {
  const frame = useCurrentFrame();
  const c = format.caption;
  const exitT = exit !== undefined ? clamp01((frame - exit) / 8) : 0;
  const kickerT = clamp01((frame - at + 4) / 8);
  const words = text.split(' ');
  return (
    <div
      style={{
        position: 'absolute', left: c.x, top: c.y, width: Math.min(c.w, maxWidth),
        textAlign: c.align, opacity: 1 - exitT,
        transform: `translateY(${-exitT * 18}px)`,
        filter: `blur(${exitT * 8}px)`,
      }}
    >
      {kicker ? (
        <div
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 10,
            fontFamily: "'IBM Plex Mono', monospace", fontSize: c.size * 0.34, fontWeight: 600,
            letterSpacing: '0.2em', textTransform: 'uppercase', color: BRAND.mint,
            marginBottom: c.size * 0.42, opacity: kickerT,
          }}
        >
          <span style={{ width: c.size * 0.17, height: c.size * 0.17, borderRadius: 999, background: BRAND.mint, display: 'inline-block' }} />
          {kicker}
        </div>
      ) : null}
      <div>
        {words.map((w, i) => (
          <Word key={i} text={w} i={i} at={at} size={c.size} color={BRAND.text} weight={640} />
        ))}
      </div>
    </div>
  );
};

// The opening hook — webhook-style decline events, then the statement.
export const LogHook: React.FC<{
  lines: { at: number; time: string; code: string; amount: string; reason: string }[];
  statement: string;
  statementAt: number;
  dimAt?: number;
  stagger?: number; // frames between word reveals (tighter for cutdowns)
  format: { hook: { y: number; size: number; gap: number }; statement: { y: number; size: number }; w: number };
}> = ({ lines, statement, statementAt, dimAt, stagger = 2.1, format }) => {
  const frame = useCurrentFrame();
  const dim = dimAt !== undefined ? clamp01((frame - dimAt) / 10) : 0;

  return (
    <div style={{ position: 'absolute', inset: 0, background: BRAND.page }}>
      <div
        style={{
          position: 'absolute', left: 0, right: 0, top: format.hook.y,
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: format.hook.gap,
          opacity: 1 - dim * 0.72, filter: `blur(${dim * 3}px)`,
        }}
      >
        {lines.map((l, i) => {
          const t = clamp01((frame - l.at) / 10);
          const clip = easeOutQuint(t);
          return (
            <div
              key={i}
              style={{
                fontFamily: "'IBM Plex Mono', monospace", fontSize: format.hook.size, fontWeight: 500,
                display: 'flex', alignItems: 'center', gap: format.hook.size * 0.55,
                opacity: t, transform: `translateY(${(1 - clip) * 8}px)`,
              }}
            >
              <span style={{ color: BRAND.muted }}>{l.time}</span>
              <span
                style={{
                  color: BRAND.neg, background: 'rgba(248,123,108,0.10)',
                  border: '1px solid rgba(248,123,108,0.28)', borderRadius: 7,
                  padding: '2px 10px', letterSpacing: '0.02em',
                }}
              >
                {l.code}
              </span>
              <span style={{ color: BRAND.text }}>{l.amount}</span>
              <span style={{ color: BRAND.muted }}>{l.reason}</span>
            </div>
          );
        })}
      </div>
      <div
        style={{
          position: 'absolute', left: format.w * 0.12, right: format.w * 0.12, top: format.statement.y,
          textAlign: 'center',
        }}
      >
        {statement.split(' ').map((w, i) => (
          <Word key={i} text={w} i={i * (stagger / 2.1)} at={statementAt} size={format.statement.size} color={BRAND.text} weight={700} />
        ))}
      </div>
    </div>
  );
};
