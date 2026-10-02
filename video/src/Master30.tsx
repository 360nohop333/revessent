// ═══════════════════════════════════════════════════════════════════
// REVESSENT — 30s master.
//
//   problem      a payment fails. then another. (webhook-log hook)
//   tension      every failed payment is a member walking out
//   product      the real dashboard, in a real browser
//   in action    queue → click a member → Retry now → succeeded →
//                draft the recovery email → send it
//   result       recovered, crossfaded in the real UI; tracked
//   brand        positioning line + CTA
//
// Every UI frame is a captured plate of the actual product.
// ═══════════════════════════════════════════════════════════════════
import React from 'react';
import { AbsoluteFill, Audio, Sequence, staticFile } from 'remotion';
import { BRAND, FORMATS, GEO, PT, type Format } from './kit';
import { CameraPlate } from './components/Plate';
import { Cursor } from './components/Cursor';
import { Caption, LogHook } from './components/Type';
import { BrowserChrome } from './components/Chrome';
import { Scene, Finish } from './components/Fx';
import { BrandEnd, DraftCover } from './components/Brand';

const F = {
  hook: [0, 96],
  reveal: [96, 168],
  queue: [168, 234],
  retry: [234, 310],
  succeeded: [310, 384],
  draft: [384, 498],
  sent: [498, 546],
  result: [546, 672],
  montageDigest: [672, 708],
  montageMembers: [708, 744],
  brand: [744, 900],
} as const;

const Sfx: React.FC<{ file: string; at: number; volume?: number }> = ({ file, at, volume = 1 }) => (
  <Sequence from={at} durationInFrames={45}>
    <Audio src={staticFile(`audio/${file}`)} volume={volume} />
  </Sequence>
);

export const Master30: React.FC<{ format: '16x9' | '9x16' | '1x1' }> = ({ format: id }) => {
  const fmt: Format = FORMATS[id];
  const windowed = id !== '16x9';
  const wrap: React.CSSProperties = windowed
    ? { position: 'absolute', left: fmt.plateView.x, top: fmt.plateView.y, width: fmt.plateView.w, height: fmt.plateView.h, borderRadius: 18, overflow: 'hidden', boxShadow: '0 34px 90px -24px rgba(0,0,0,0.85)', border: '1px solid rgba(255,255,255,0.07)' }
    : { position: 'absolute', inset: 0 };
  const view = { x: 0, y: 0, w: fmt.plateView.w, h: fmt.plateView.h };
  const plate = (name: string) => staticFile(`plates/${name}.png`);

  return (
    <AbsoluteFill style={{ background: BRAND.page, fontFamily: 'Inter, sans-serif' }}>
      {/* ── music + sfx ── */}
      <Audio src={staticFile('audio/music-30.wav')} volume={0.92} />
      <Sfx file="tick.wav" at={F.hook[0] + 8} volume={0.8} />
      <Sfx file="tick.wav" at={F.hook[0] + 30} volume={0.8} />
      <Sfx file="tick.wav" at={F.hook[0] + 52} volume={0.8} />
      <Sfx file="whoosh.wav" at={F.reveal[0] - 3} volume={0.9} />
      <Sfx file="click.wav" at={F.queue[0] + 60} volume={0.95} />
      <Sfx file="click.wav" at={F.retry[0] + 68} volume={0.95} />
      <Sfx file="success.wav" at={F.succeeded[0]} volume={0.9} />
      <Sfx file="click.wav" at={F.draft[0] + 30} volume={0.95} />
      <Sfx file="click.wav" at={F.draft[0] + 108} volume={0.95} />
      <Sfx file="send.wav" at={F.sent[0]} volume={0.9} />
      <Sfx file="kpi.wav" at={F.result[0] + 34} volume={0.85} />
      <Sfx file="whoosh.wav" at={F.brand[0] - 3} volume={0.8} />

      {/* ── 1 · the hook: payments fail, quietly ── */}
      <Scene from={F.hook[0]} duration={F.hook[1] - F.hook[0]} exit="blur">
        <LogHook
          format={fmt}
          lines={[
            { at: 8, time: '21:41', code: 'payment_failed', amount: '₹1,299', reason: 'card_expired' },
            { at: 30, time: '21:52', code: 'payment_failed', amount: '₹899', reason: 'insufficient_funds' },
            { at: 52, time: '22:07', code: 'payment_failed', amount: '₹2,499', reason: 'insufficient_funds' },
          ]}
          statement="Every failed payment is a member walking out."
          statementAt={66}
          dimAt={84}
        />
      </Scene>

      {/* ── 2 · the real product, in a real browser ── */}
      <Scene from={F.reveal[0]} duration={F.reveal[1] - F.reveal[0]} enter="blur">
        <div style={wrap}>
          <CameraPlate src={plate('dash-hero')} view={view} camFrom={{ x: PT.kpiRecovered.x, y: PT.kpiRecovered.y, zoom: 2.05 }} camTo={{ x: 800, y: 500, zoom: 1.0 }} camAt={[4, 58]} />
          <BrowserChrome url="revessent-alpha.vercel.app/dashboard" title="Revessent — Overview" collapseAt={52} />
        </div>
        <Caption at={26} exit={62} kicker="Revenue intelligence" text="This is Revessent." format={fmt} />
      </Scene>

      {/* ── 3 · the queue — click into a member ── */}
      <Scene from={F.queue[0]} duration={F.queue[1] - F.queue[0]}>
        <div style={wrap}>
          <CameraPlate src={plate('dash-queue')} view={view} camFrom={{ x: 800, y: 295, zoom: 1.34 }} camTo={{ x: 800, y: 345, zoom: 1.3 }} camAt={[0, 66]}>
            <Cursor
              appear={12}
              points={[
                { f: 0, x: 1250, y: 120 }, { f: 16, x: 1250, y: 120 },
                { f: 44, x: PT.queueRow1.x, y: PT.queueRow1.y }, { f: 60, x: PT.queueRow1.x, y: PT.queueRow1.y },
              ]}
              clicks={[{ f: 60 }]}
            />
          </CameraPlate>
        </div>
      </Scene>

      {/* ── 4 · retry now ── */}
      <Scene from={F.retry[0]} duration={F.retry[1] - F.retry[0]}>
        <div style={wrap}>
          <CameraPlate src={plate('case-before')} view={view} camFrom={{ x: 640, y: 330, zoom: 1.5 }} camTo={{ x: 640, y: 332, zoom: 1.53 }} camAt={[0, 76]}>
            <Cursor
              appear={4}
              points={[
                { f: 0, x: 1050, y: 170 }, { f: 6, x: 1050, y: 170 },
                { f: 40, x: PT.retryBtn.x, y: PT.retryBtn.y }, { f: 68, x: PT.retryBtn.x, y: PT.retryBtn.y },
              ]}
              clicks={[{ f: 68 }]}
            />
          </CameraPlate>
        </div>
      </Scene>

      {/* ── 5 · recovered — the real UI says so ── */}
      <Scene from={F.succeeded[0]} duration={F.succeeded[1] - F.succeeded[0]}>
        <div style={wrap}>
          <CameraPlate src={plate('case-after')} view={view} camFrom={{ x: 640, y: 330, zoom: 1.5 }} camTo={{ x: 640, y: 336, zoom: 1.57 }} camAt={[0, 74]} />
        </div>
        <Caption at={22} exit={62} kicker="Smart retries" text="Retries, timed to each member." format={fmt} />
      </Scene>

      {/* ── 6 · the recovery email, in your voice ── */}
      <Scene from={F.draft[0]} duration={F.draft[1] - F.draft[0]}>
        <div style={wrap}>
          <CameraPlate src={plate('case-draft')} view={view} camFrom={{ x: PT.draftBtn.x, y: PT.draftBtn.y, zoom: 1.9 }} camTo={{ x: 640, y: 620, zoom: 1.3 }} camAt={[30, 104]}>
            <DraftCover box={GEO.draftBox} revealAt={31} />
            <Cursor
              appear={2}
              points={[
                { f: 0, x: 860, y: 160 }, { f: 8, x: 860, y: 160 },
                { f: 26, x: PT.draftBtn.x, y: PT.draftBtn.y }, { f: 30, x: PT.draftBtn.x, y: PT.draftBtn.y },
                { f: 76, x: PT.draftBtn.x, y: PT.draftBtn.y },
                { f: 104, x: PT.sendDraftBtn.x, y: PT.sendDraftBtn.y }, { f: 112, x: PT.sendDraftBtn.x, y: PT.sendDraftBtn.y },
              ]}
              clicks={[{ f: 30 }, { f: 108 }]}
            />
          </CameraPlate>
        </div>
        <Caption at={58} exit={102} kicker="Outreach" text="Recovery emails, in your voice." format={fmt} />
      </Scene>

      {/* ── 7 · sent — the timeline tells it ── */}
      <Scene from={F.sent[0]} duration={F.sent[1] - F.sent[0]}>
        <div style={wrap}>
          <CameraPlate src={plate('case-sent')} view={view} camFrom={{ x: 1270, y: 420, zoom: 1.66 }} camTo={{ x: 1290, y: 448, zoom: 1.8 }} camAt={[0, 48]} />
        </div>
      </Scene>

      {/* ── 8 · the result — real numbers crossfade in the real UI ── */}
      <Scene from={F.result[0]} duration={F.result[1] - F.result[0]}>
        <div style={wrap}>
          <CameraPlate
            src={plate('dash-hero')}
            crossfadeTo={plate('dash-hero-v2')}
            crossfadeAt={34}
            crossfadeDur={16}
            view={view}
            camFrom={{ x: PT.kpiRecovered.x, y: PT.kpiRecovered.y, zoom: 2.1 }}
            camTo={{ x: 700, y: 470, zoom: 1.15 }}
            camAt={[34, 112]}
          />
        </div>
        <Caption at={56} exit={112} kicker="Results" text="Recovered. Tracked to the rupee." format={fmt} />
      </Scene>

      {/* ── 9 · montage — the rest of the machine ── */}
      <Scene from={F.montageDigest[0]} duration={F.montageDigest[1] - F.montageDigest[0]}>
        <div style={wrap}>
          <CameraPlate src={plate('digest')} view={view} camFrom={{ x: 930, y: 380, zoom: 1.42 }} camTo={{ x: 930, y: 418, zoom: 1.34 }} camAt={[0, 36]} />
        </div>
      </Scene>
      <Scene from={F.montageMembers[0]} duration={F.montageMembers[1] - F.montageMembers[0]}>
        <div style={wrap}>
          <CameraPlate src={plate('members')} view={view} camFrom={{ x: 930, y: 430, zoom: 1.46 }} camTo={{ x: 930, y: 462, zoom: 1.38 }} camAt={[0, 36]} />
        </div>
      </Scene>

      {/* ── 10 · brand ── */}
      <Sequence from={F.brand[0]} durationInFrames={F.brand[1] - F.brand[0]}>
        <BrandEnd format={fmt} from={F.brand[0]} bg="plates/dash-hero-v2.png" />
      </Sequence>

      <Finish w={fmt.w} h={fmt.h} />
    </AbsoluteFill>
  );
};
