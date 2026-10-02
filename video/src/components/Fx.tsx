// Scene wrapper (enter/exit treatments) + full-frame finish:
// film grain, vignette. Restrained — this is glue, not decoration.
import React from 'react';
import { interpolate, useCurrentFrame } from 'remotion';
import { Sequence } from 'remotion';
import { clamp01 } from '../kit';

export const Scene: React.FC<{
  from: number;
  duration: number;
  enter?: 'cut' | 'blur' | 'fade';
  exit?: 'cut' | 'blur' | 'fade';
  children: React.ReactNode;
}> = ({ from, duration, enter = 'cut', exit = 'cut', children }) => {
  return (
    <Sequence from={from} durationInFrames={duration}>
      <SceneEffects enter={enter} exit={exit} duration={duration}>
        {children}
      </SceneEffects>
    </Sequence>
  );
};

const SceneEffects: React.FC<{ enter: string; exit: string; duration: number; children: React.ReactNode }> = ({
  enter, exit, duration, children,
}) => {
  const frame = useCurrentFrame();
  let blur = 0, scale = 1, opacity = 1;

  if (enter === 'blur') {
    const t = clamp01(frame / 11);
    blur = (1 - t) * 16;
    scale = 0.988 + t * 0.012;
    opacity = t;
  } else if (enter === 'fade') {
    opacity = clamp01(frame / 9);
  }
  if (exit === 'blur') {
    const t = clamp01((frame - (duration - 9)) / 9);
    blur = Math.max(blur, t * 12);
    scale = 1 + t * 0.018;
  } else if (exit === 'fade') {
    opacity *= 1 - clamp01((frame - (duration - 9)) / 9);
  }

  return (
    <div style={{ position: 'absolute', inset: 0, filter: blur > 0.05 ? `blur(${blur}px)` : undefined, transform: `scale(${scale})`, opacity }}>
      {children}
    </div>
  );
};

const GRAIN =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='2' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E";

export const Finish: React.FC<{ w: number; h: number }> = ({ w, h }) => {
  const frame = useCurrentFrame();
  // grain flickers faintly (two alternating offsets — cheap life)
  const off = frame % 2 === 0 ? 0 : 6;
  return (
    <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 60 }}>
      <div
        style={{
          position: 'absolute', inset: -8,
          backgroundImage: `url("${GRAIN}")`, backgroundSize: '240px 240px',
          backgroundPosition: `${off}px ${off}px`,
          opacity: 0.045, mixBlendMode: 'overlay',
        }}
      />
      <div
        style={{
          position: 'absolute', inset: 0,
          background: `radial-gradient(120% 90% at 50% 42%, transparent 55%, rgba(0,0,0,0.36) 100%)`,
        }}
      />
      <div style={{ position: 'absolute', inset: 0, boxShadow: `inset 0 0 ${Math.round(h * 0.012)}px rgba(0,0,0,0.35)` }} />
    </div>
  );
};
