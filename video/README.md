# Revessent — advertising video

A code-based, fully editable ad built with **Remotion**, driven entirely by
**real screenshots of the actual product** (no mockups, no invented UI). The
project is self-contained in `video/` and separate from the SaaS core.

## Deliverables

Rendered MP4s live in `renders/` (H.264 + AAC, 30 fps):

| File | Aspect | Length | Use |
|---|---|---|---|
| `master30-16x9.mp4` | 1920×1080 | 30 s | YouTube / site hero |
| `master30-9x16.mp4` | 1080×1920 | 30 s | Reels / Shorts |
| `master30-1x1.mp4` | 1080×1080 | 30 s | Feed |
| `cutdown15-16x9.mp4` | 1920×1080 | 15 s | Pre-roll |
| `cutdown15-9x16.mp4` | 1080×1920 | 15 s | Reels / Shorts |
| `cutdown15-1x1.mp4` | 1080×1080 | 15 s | Feed |

Every format is **purpose-built**, not cropped: the UI window, type, captions
and CTA re-layout per aspect (`src/kit.ts → FORMATS`).

## Story arc (30 s master)

| Beat | Time | What happens |
|---|---|---|
| Problem | 0–3.2 s | Webhook-log lines: `payment_failed` events stack up → "Every failed payment is a member walking out." |
| Product | 3.2–5.6 s | Real browser chrome → the real dashboard |
| In action | 5.6–16.6 s | Queue → click a member → **Retry now** → `succeeded` → **Draft recovery email** → send |
| Result | 18.2–24.8 s | Dashboard crossfades to recovered state (the product's own illustrative demo KPIs) |
| Brand | 24.8–30 s | Mark + wordmark, positioning line, CTA |

The 15 s cutdown is a **re-edit**, not a chop: compressed hook, the email
already drafted (just send), result beat merged, no montage.

## Pipeline

```
capture/capture.mjs     drives the real app (demo state) in headless Chromium,
                        screenshots each beat @2× → public/plates/*.png
                        + geometry.json (UI element rects, merged on load)
audio/build-audio.mjs   synthesizes SFX + two music beds (30 s / 15 s) with
                        section marks baked in → public/audio/*.wav
src/                    Remotion compositions + reusable components
qa-frames.mjs           numeric frame QA (grid/region probes on rendered MP4s)
```

### Setup

```bash
cd video
npm install
npm run capture        # optional — plates are committed; re-run after UI changes
npm run audio          # optional — audio is committed; re-run after retiming
```

The first render/studio launch auto-inflates a headless Chromium from
`@sparticuz/chromium` into `/tmp` (see `remotion.config.ts`).

### Preview

```bash
npm run studio         # Remotion Studio at localhost:3000 — scrub every comp
```

### Render

```bash
npm run render:all                       # all six deliverables → renders/
npx remotion render src/index.tsx Master30-16x9 renders/foo.mp4   # one comp
```

Compositions: `Master30-{16x9,9x16,1x1}`, `Cutdown15-{16x9,9x16,1x1}`.

## Editing guide

- **Timeline** — beat windows are the `F` map at the top of
  `src/Master30.tsx` / `src/Cutdown15.tsx`. Move a beat by editing its frame
  range; captions, cursors and camera moves are all keyed to these windows.
- **Camera** — every product shot is a captured plate under a camera
  (`camFrom → camTo`, plate-space center + zoom, `camAt` = move window).
  Zoom `1.0` = plate covers the view; the transform auto-clamps so no format
  ever shows gutters. Geometry for aiming comes from `geometry.json`
  (`GEO` / `PT` in `src/kit.ts`).
- **Cursor** — `src/components/Cursor.tsx`: bezier arcs, launch/decelerate
  easing, hold points, click ripple. Keyed in plate space so it sticks to
  real UI targets under any camera move.
- **Copy** — captions/kickers in the two timeline files; hook lines + CTA
  text in the same places. All claims mirror the product's own copy
  ("14-day pilot", "Razorpay-native", "PCI-conscious"); dashboard numbers are
  the product's *illustrative* demo KPIs — kept as-is, no invented figures.
- **Music/SFX** — `audio/build-audio.mjs` has a `MARKS` map per bed; if you
  retime scenes, update the marks and re-run `npm run audio`.
- **New beats** — re-run `npm run capture -- --only <shot>` to add a plate
  (geometry merges, other shots are preserved), then drop a
  `<CameraPlate>` scene into the timeline.

## QA

`qa-frames.mjs` extracts probe frames from a render and checks them
numerically (text coverage where captions should be, mint/CTA presence,
dark-frame sanity, cursor visibility):

```bash
node qa-frames.mjs renders/master30-16x9.mp4 '[{"f":880,"name":"brand","regions":{"cta":[0.3,0.6,0.7,0.72]}}]'
```

The six deliverables were each probed this way (hook, reveal, click beats,
draft cover, result crossfade, brand) before shipping.

## Honesty constraints

- All UI footage = captured plates of the real app (`public/plates/`) — no
  recreated or AI-generated UI, no invented buttons or numbers.
- The one composited moment — the draft email "opening" — is a wipe that
  reveals the real captured draft; nothing is drawn in.
- Demo KPIs shown are the product's own illustrative demo values.
