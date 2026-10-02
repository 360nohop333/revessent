#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════
// Revessent ad — audio, synthesized (no external assets, no licenses).
// UI sounds are deliberately quiet; the music bed is minimal and
// restrained: a soft C-minor pad, a felt kick, a filtered pulse, a
// gentle arp for the result act, one riser into the brand frame.
// The ad must work muted — this only enhances it.
//
//   node audio/build-audio.mjs   →  public/audio/*.wav
// ═══════════════════════════════════════════════════════════════════
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../public/audio');
fs.mkdirSync(OUT, { recursive: true });

const SR = 44100;

// ── wav writer (16-bit PCM) ────────────────────────────────────────
function writeWav(file, channels /* Float32Array[] */) {
  const nCh = channels.length;
  const n = channels[0].length;
  const data = Buffer.alloc(n * nCh * 2);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nCh; c++) {
      const v = Math.max(-1, Math.min(1, channels[c][i]));
      data.writeInt16LE(Math.round(v * 32767), (i * nCh + c) * 2);
    }
  }
  const hdr = Buffer.alloc(44);
  hdr.write('RIFF', 0); hdr.writeUInt32LE(36 + data.length, 4); hdr.write('WAVE', 8);
  hdr.write('fmt ', 12); hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(nCh, 22);
  hdr.writeUInt32LE(SR, 24); hdr.writeUInt32LE(SR * nCh * 2, 28); hdr.writeUInt16LE(nCh * 2, 32); hdr.writeUInt16LE(16, 34);
  hdr.write('data', 36); hdr.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(OUT, file), Buffer.concat([hdr, data]));
  let peak = 0, sumSq = 0;
  for (let i = 0; i < n; i++) { const v = Math.abs(channels[0][i]); if (v > peak) peak = v; sumSq += channels[0][i] * channels[0][i]; }
  const rms = Math.sqrt(sumSq / n);
  console.log(`  ♪ ${file}  ${(n / SR).toFixed(2)}s  peak=${(20 * Math.log10(peak || 1e-9)).toFixed(1)}dB  rms=${(20 * Math.log10(rms || 1e-9)).toFixed(1)}dB`);
}

const N = (sec) => Math.round(sec * SR);
const midi = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ── SFX ────────────────────────────────────────────────────────────
function sfx() {
  // tick — a quiet UI event blip (log line appears)
  {
    const buf = new Float32Array(N(0.09));
    for (let i = 0; i < buf.length; i++) {
      const t = i / SR;
      buf[i] = (Math.sin(2 * Math.PI * 2600 * t) * Math.exp(-t * 160) * 0.6
        + Math.sin(2 * Math.PI * 1400 * t) * Math.exp(-t * 110) * 0.4) * 0.42;
    }
    writeWav('tick.wav', [buf]);
  }
  // click — cursor press (thock + tick)
  {
    const buf = new Float32Array(N(0.12));
    let ph = 0;
    for (let i = 0; i < buf.length; i++) {
      const t = i / SR;
      const f = 165 * Math.exp(-t * 30) + 55;
      ph += (2 * Math.PI * f) / SR;
      buf[i] = (Math.sin(ph) * Math.exp(-t * 36) * 0.8
        + Math.sin(2 * Math.PI * 2900 * t) * Math.exp(-t * 220) * 0.5) * 0.5;
    }
    writeWav('click.wav', [buf]);
  }
  // whoosh — scene transition (stereo, filtered noise sweep)
  {
    const n = N(0.55), L = new Float32Array(n), R = new Float32Array(n);
    let lp1 = 0, lp2 = 0, prev = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const cut = 0.02 + 0.16 * Math.sin(Math.PI * Math.min(1, t * 1.15));
      const noise = Math.random() * 2 - 1;
      lp1 += cut * (noise - lp1);
      lp2 += cut * (lp1 - lp2);
      const env = Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.02)), 1.6) * (t > 0.7 ? Math.exp(-(t - 0.7) * 6) : 1);
      L[i] = lp2 * env * 0.5;
      R[i] = (lp2 * 0.9 + (noise - prev) * 0.05) * env * 0.5;
      prev = noise;
    }
    writeWav('whoosh.wav', [L, R]);
  }
  // success — recovered toast (two soft bell notes)
  {
    const buf = new Float32Array(N(0.8));
    const notes = [[784, 0], [1175, 0.14]]; // G5 → D6
    for (let i = 0; i < buf.length; i++) {
      const t = i / SR;
      let s = 0;
      for (const [f, st] of notes) {
        const tt = t - st;
        if (tt < 0) continue;
        s += (Math.sin(2 * Math.PI * f * tt) + 0.35 * Math.sin(2 * Math.PI * f * 2 * tt)) * Math.exp(-tt * 5.5);
      }
      buf[i] = s * 0.22;
    }
    writeWav('success.wav', [buf]);
  }
  // send — email sent (airy upward flick)
  {
    const n = N(0.34), buf = new Float32Array(n);
    let lp = 0, ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / n;
      const cut = 0.05 + 0.3 * t * t;
      lp += cut * ((Math.random() * 2 - 1) - lp);
      ph += (2 * Math.PI * (500 + 2200 * t * t)) / SR;
      const env = Math.sin(Math.PI * Math.min(1, t * 1.1));
      buf[i] = (lp * 0.7 + Math.sin(ph) * 0.12) * env * 0.4;
    }
    writeWav('send.wav', [buf]);
  }
  // kpi — small counter tick-up accent
  {
    const buf = new Float32Array(N(0.16));
    for (let i = 0; i < buf.length; i++) {
      const t = i / SR;
      buf[i] = (Math.sin(2 * Math.PI * 1046 * t) * Math.exp(-t * 26) * 0.7
        + Math.sin(2 * Math.PI * 1318 * Math.max(0, t - 0.03)) * Math.exp(-(t - 0.03) * 26) * 0.5) * 0.3;
    }
    writeWav('kpi.wav', [buf]);
  }
}

// ── music bed ──────────────────────────────────────────────────────
// 90 BPM · C minor · i–VI–III–VII, two bars each.
const CHORDS = [
  ['Cm9', [48, 51, 55, 58, 62]],       // C3 Eb3 G3 Bb3 D4
  ['Abmaj9', [44, 48, 51, 55, 58]],    // Ab2 C3 Eb3 G3 Bb3
  ['Ebmaj9', [51, 55, 58, 62, 65]],    // Eb3 G3 Bb3 D4 F4
  ['Bbsus2', [46, 50, 53, 58, 60]],    // Bb2 D3 F3 Bb3 C4
];

function renderMusic(seconds, marks) {
  // marks: {drums, lift, riser, brand} in seconds
  const n = N(seconds);
  const L = new Float32Array(n), R = new Float32Array(n);
  const beat = 60 / 90; // 0.6667
  const bar = beat * 4;

  // — pad: chord per 2 bars, continuous, crossfaded —
  let chordIdx = 0;
  for (let t = 0; t < seconds; t += bar * 2) {
    const [, notes] = CHORDS[chordIdx % CHORDS.length];
    chordIdx++;
    const segStart = t, segEnd = Math.min(seconds, t + bar * 2 + 1.4); // overlap tail
    const s0 = N(segStart), s1 = N(segEnd);
    for (let i = s0; i < s1 && i < n; i++) {
      const tt = (i - s0) / SR;
      const dur = segEnd - segStart;
      let env = Math.min(1, tt / 0.9) * Math.min(1, Math.max(0, (dur - tt)) / 1.1);
      // brand section: swell the pad
      if (i / SR >= marks.brand) env *= 1.0 + 0.5 * Math.min(1, (i / SR - marks.brand) / 0.8);
      let sL = 0, sR = 0;
      notes.forEach((m, k) => {
        const f = midi(m);
        const det = 1 + (k % 2 ? 0.0012 : -0.0012);
        const a = Math.sin(2 * Math.PI * f * det * tt) + 0.22 * Math.sin(2 * Math.PI * f * 2 * tt);
        const pan = 0.35 + 0.3 * (k / notes.length); // spread voices slightly
        const g = 0.055 / Math.sqrt(k + 1);
        sL += a * g * (1 - pan * 0.6);
        sR += a * g * (0.4 + pan * 0.6);
      });
      L[i] += sL * env; R[i] += sR * env;
    }
  }

  // — kick (felt) + sidechain —
  const kicks = [];
  for (let t = marks.drums; t < Math.min(seconds, marks.brand - 0.05); t += beat) {
    const b = Math.round(t / beat);
    if ((b % 2) !== 0) continue; // beats 1 & 3
    kicks.push(t);
    let ph = 0;
    for (let i = N(t); i < Math.min(n, N(t + 0.16)); i++) {
      const tt = (i - N(t)) / SR;
      const f = 46 + 78 * Math.exp(-tt * 34);
      ph += (2 * Math.PI * f) / SR;
      const v = Math.sin(ph) * Math.exp(-tt * 17) * 0.34;
      L[i] += v; R[i] += v;
    }
  }
  // sidechain duck on pad
  for (const kt of kicks) {
    for (let i = N(kt); i < Math.min(n, N(kt + 0.24)); i++) {
      const tt = (i - N(kt)) / SR;
      const duck = 1 - 0.3 * Math.exp(-tt * 9);
      L[i] *= duck; R[i] *= duck;
    }
  }

  // — pulse: filtered 8th-note noise, from drums to lift —
  {
    let lp = 0;
    for (let t = marks.drums; t < Math.min(seconds, marks.brand - 0.05); t += beat / 2) {
      for (let i = N(t); i < Math.min(n, N(t + 0.07)); i++) {
        const tt = (i - N(t)) / SR;
        const noise = Math.random() * 2 - 1;
        lp += 0.18 * (noise - lp);
        const v = lp * Math.exp(-tt * 60) * 0.075;
        L[i] += v * 0.9; R[i] += v;
      }
    }
  }

  // — arp (result act): gentle 8ths, one echo —
  if (marks.lift < seconds) {
    const seq = [72, 75, 79, 82, 79, 75]; // C5 Eb5 G5 Bb5
    let k = 0;
    const arpNotes = [];
    for (let t = marks.lift; t < Math.min(seconds, marks.brand - 0.05); t += beat / 2) {
      arpNotes.push([t, midi(seq[k++ % seq.length])]);
    }
    for (const [t, f] of arpNotes) {
      for (let i = N(t); i < Math.min(n, N(t + 0.3)); i++) {
        const tt = (i - N(t)) / SR;
        const v = (Math.sin(2 * Math.PI * f * tt) + 0.15 * Math.sin(2 * Math.PI * f * 2 * tt)) * Math.exp(-tt * 9) * 0.045;
        L[i] += v; R[i] += v * 0.85;
        // one echo at +3/16
        const e = i + N(beat * 0.375);
        if (e < n) { L[e] += v * 0.35; R[e] += v * 0.3; }
      }
    }
  }

  // — riser into brand —
  if (marks.riser > 0) {
    const t0 = marks.riser, t1 = marks.brand;
    let lp = 0;
    for (let i = N(t0); i < Math.min(n, N(t1)); i++) {
      const t = (i / SR - t0) / (t1 - t0);
      const cut = 0.03 + 0.28 * t * t;
      lp += cut * ((Math.random() * 2 - 1) - lp);
      const env = t * t * 0.11;
      L[i] += lp * env; R[i] += lp * env * 0.95;
    }
  }

  // — simple stereo reverb (comb + allpass) —
  const rev = (dry, wetAmt) => {
    const out = new Float32Array(dry.length);
    const combs = [[1117, 0.775], [1187, 0.775], [1277, 0.782], [1357, 0.782]];
    const buffers = combs.map(([d]) => new Float32Array(d));
    const idx = new Array(combs.length).fill(0);
    const ap1 = new Float32Array(225), ap2 = new Float32Array(556);
    let a1 = 0, a2 = 0, i1 = 0, i2 = 0;
    for (let i = 0; i < dry.length; i++) {
      let s = 0;
      for (let c = 0; c < combs.length; c++) {
        const [d, fb] = combs[c];
        const buf = buffers[c];
        const outv = buf[idx[c]];
        buf[idx[c]] = dry[i] + outv * fb;
        idx[c] = (idx[c] + 1) % d;
        s += outv;
      }
      s *= 0.25;
      // allpass 1
      const v1 = ap1[i1]; const tmp = s + v1 * 0.7; ap1[i1] = tmp; a1 = v1 - s * 0.7; i1 = (i1 + 1) % 225;
      const v2 = ap2[i2]; const tmp2 = a1 + v2 * 0.7; ap2[i2] = tmp2; a2 = v2 - a1 * 0.7; i2 = (i2 + 1) % 556;
      out[i] = dry[i] + a2 * wetAmt;
    }
    return out;
  };
  const Lr = rev(L, 0.22), Rr = rev(R, 0.22);

  // — master: soft clip + normalize to −3 dBFS —
  let peak = 0;
  for (let i = 0; i < n; i++) {
    Lr[i] = Math.tanh(Lr[i] * 1.25); Rr[i] = Math.tanh(Rr[i] * 1.25);
    peak = Math.max(peak, Math.abs(Lr[i]), Math.abs(Rr[i]));
  }
  const g = 0.707 / (peak || 1);
  for (let i = 0; i < n; i++) { Lr[i] *= g; Rr[i] *= g; }
  return [Lr, Rr];
}

console.log('SFX:');
sfx();
console.log('Music beds:');
writeWav('music-30.wav', renderMusic(30, { drums: 5.6, lift: 18.2, riser: 22.5, brand: 24.8 }));
writeWav('music-15.wav', renderMusic(15, { drums: 2.0, lift: 8.2, riser: 11.5, brand: 12.0 }));
console.log('\n· audio in video/public/audio/');
