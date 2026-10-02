// ═══════════════════════════════════════════════════════════════════
// REVESSENT — 15s cutdown. Re-edited for a shorter attention span:
// same arc, compressed beats, the draft email already written, no
// montage. Not a chop of the 30s master.
// ═══════════════════════════════════════════════════════════════════
import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { BRAND, FORMATS, GEO, PT, type Format } from './kit';
import { CameraPlate } from './components/Plate';
import { Cursor } from './components/Cursor';
import { Caption, LogHook } from './components/Type';
import { BrowserChrome } from './components/Chrome';
import { Scene, Finish } from './components/Fx';
import { BrandEnd } from './components/Brand';

const F = {
  hook: [0, 60],
  reveal: [60, 114],
  queue: [114, 156],
  retry: [156, 204],
  succeeded: [204, 240],
  draft: [240, 306],
  result: [306, 360],
  brand: [360, 450],
} as const;

const Sfx: React.FC<{ file: string; at: number; volume?: number }> = ({ file, at, volume = 1 }) => (
  <Sequence from={at} durationInFrames={45}>
    <Audio src={staticFile(`audio/${file}`)} volume={volume} />
  </Sequence>
);

export const Cutdown15: React.FC<{ format: '16x9' | '9x16' | '1x1' }> = ({ format: id }) => {
  const fmt: Format = FORMATS[id];
  const windowed = id !== '16x9';
  const wrap: React.CSSProperties = windowed
    ? { position: 'absolute', left: fmt.plateView.x, top: fmt.plateView.y, width: fmt.plateView.w, height: fmt.plateView.h, borderRadius: 18, overflow: 'hidden', boxShadow: '0 34px 90px -24px rgba(0,0,0,0.85)', border: '1px solid rgba(255,255,255,0.07)' }
    : { position: 'absolute', inset: 0 };
  const view = { x: 0, y: 0, w: fmt.plateView.w, h: fmt.plateView.h };
  const plate = (name: string) => staticFile(`plates/${name}.png`);

  return (
    <AbsoluteFill style={{ background: BRAND.page, fontFamily: 'Inter, sans-serif' }}>
      <Audio src={staticFile('audio/music-15.wav')} volume={0.92} />
      <Sfx file="tick.wav" at={F.hook[0] + 4} volume={0.8} />
      <Sfx file="tick.wav" at={F.hook[0] + 18} volume={0.8} />
      <Sfx file="whoosh.wav" at={F.reveal[0] - 3} volume={0.9} />
      <Sfx file="click.wav" at={F.queue[0] + 38} volume={0.95} />
      <Sfx file="click.wav" at={F.retry[0] + 42} volume={0.95} />
      <Sfx file="success.wav" at={F.succeeded[0]} volume={0.9} />
      <Sfx file="click.wav" at={F.draft[0] + 50} volume={0.95} />
      <Sfx file="send.wav" at={F.result[0]} volume={0.85} />
      <Sfx file="kpi.wav" at={F.result[0] + 24} volume={0.85} />

      {/* 1 · hook — compressed */}
      <Scene from={F.hook[0]} duration={F.hook[1] - F.hook[0]} exit="blur">
        <LogHook
          format={fmt}
          lines={[
            { at: 4, time: '21:41', code: 'payment_failed', amount: '₹1,299', reason: 'card_expired' },
            { at: 18, time: '21:52', code: 'payment_failed', amount: '₹899', reason: 'insufficient_funds' },
          ]}
          statement="Every failed payment is a member walking out."
          statementAt={30}
          dimAt={50}
          stagger={1.0}
        />
      </Scene>

      {/* 2 · reveal */}
      <Scene from={F.reveal[0]} duration={F.reveal[1] - F.reveal[0]} enter="blur">
        <div style={wrap}>
          <CameraPlate src={plate('dash-hero')} view={view} camFrom={{ x: PT.kpiRecovered.x, y: PT.kpiRecovered.y, zoom: 2.1 }} camTo={{ x: 800, y: 500, zoom: 1.0 }} camAt={[2, 44]} />
          <BrowserChrome url="revessent-alpha.vercel.app/dashboard" title="Revessent — Overview" collapseAt={40} />
        </div>
        <Caption at={16} exit={46} kicker="Revenue intelligence" text="This is Revessent." format={fmt} />
      </Scene>

      {/* 3 · queue → click */}
      <Scene from={F.queue[0]} duration={F.queue[1] - F.queue[0]}>
        <div style={wrap}>
          <CameraPlate src={plate('dash-queue')} view={view} camFrom={{ x: 800, y: 300, zoom: 1.36 }} camTo={{ x: 800, y: 335, zoom: 1.3 }} camAt={[0, 42]}>
            <Cursor
              appear={8}
              points={[
                { f: 0, x: 1250, y: 120 }, { f: 12, x: 1250, y: 120 },
                { f: 32, x: PT.queueRow1.x, y: PT.queueRow1.y }, { f: 42, x: PT.queueRow1.x, y: PT.queueRow1.y },
              ]}
              clicks={[{ f: 38 }]}
            />
          </CameraPlate>
        </div>
      </Scene>

      {/* 4 · retry */}
      <Scene from={F.retry[0]} duration={F.retry[1] - F.retry[0]}>
        <div style={wrap}>
          <CameraPlate src={plate('case-before')} view={view} camFrom={{ x: 640, y: 330, zoom: 1.52 }} camTo={{ x: 640, y: 334, zoom: 1.56 }} camAt={[0, 48]}>
            <Cursor
              appear={2}
              points={[
                { f: 0, x: 1050, y: 170 }, { f: 4, x: 1050, y: 170 },
                { f: 30, x: PT.retryBtn.x, y: PT.retryBtn.y }, { f: 44, x: PT.retryBtn.x, y: PT.retryBtn.y },
              ]}
              clicks={[{ f: 42 }]}
            />
          </CameraPlate>
        </div>
      </Scene>

      {/* 5 · succeeded */}
      <Scene from={F.succeeded[0]} duration={F.succeeded[1] - F.succeeded[0]}>
        <div style={wrap}>
          <CameraPlate src={plate('case-after')} view={view} camFrom={{ x: 640, y: 330, zoom: 1.52 }} camTo={{ x: 640, y: 338, zoom: 1.6 }} camAt={[0, 36]} />
        </div>
        <Caption at={10} exit={30} kicker="Smart retries" text="Retries, timed to each member." format={fmt} />
      </Scene>

      {/* 6 · the email, already written by the product — just send it */}
      <Scene from={F.draft[0]} duration={F.draft[1] - F.draft[0]}>
        <div style={wrap}>
          <CameraPlate src={plate('case-draft')} view={view} camFrom={{ x: 640, y: 560, zoom: 1.4 }} camTo={{ x: 640, y: 600, zoom: 1.3 }} camAt={[0, 66]}>
            <Cursor
              appear={6}
              points={[
                { f: 0, x: 900, y: 260 }, { f: 10, x: 900, y: 260 },
                { f: 42, x: PT.sendDraftBtn.x, y: PT.sendDraftBtn.y }, { f: 56, x: PT.sendDraftBtn.x, y: PT.sendDraftBtn.y },
              ]}
              clicks={[{ f: 50 }]}
            />
          </CameraPlate>
        </div>
        <Caption at={14} exit={56} kicker="Outreach" text="Recovery emails, in your voice." format={fmt} />
      </Scene>

      {/* 7 · sent + result (one beat) */}
      <Scene from={F.result[0]} duration={F.result[1] - F.result[0]}>
        <div style={wrap}>
          <CameraPlate
            src={plate('dash-hero')}
            crossfadeTo={plate('dash-hero-v2')}
            crossfadeAt={20}
            crossfadeDur={14}
            view={view}
            camFrom={{ x: PT.kpiRecovered.x, y: PT.kpiRecovered.y, zoom: 2.15 }}
            camTo={{ x: 700, y: 470, zoom: 1.15 }}
            camAt={[20, 54]}
          />
        </div>
        <Caption at={30} exit={50} kicker="Results" text="Recovered. Tracked to the rupee." format={fmt} />
      </Scene>

      {/* 8 · brand */}
      <Sequence from={F.brand[0]} durationInFrames={F.brand[1] - F.brand[0]}>
        <BrandEnd format={fmt} from={F.brand[0]} bg="plates/dash-hero-v2.png" />
      </Sequence>

      <Finish w={fmt.w} h={fmt.h} />
    </AbsoluteFill>
  );
};
