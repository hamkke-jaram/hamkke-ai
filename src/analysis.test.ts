import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, analyzeAudio, estimatePitch } from './audio';
import { isTogether, jointPlaySeconds, personFromLandmarks, type Landmark } from './pose';

// 결정적인 의사 난수(테스트 재현용)
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296 - 0.5;
  };
}

function makeTrack(seconds: number, noise = 0.003) {
  const r = rng(42);
  const x = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < x.length; i++) x[i] = r() * 2 * noise;
  return x;
}

/** 배음이 있는 목소리 비슷한 소리를 더한다. */
function addVoice(x: Float32Array, f0: number, start: number, dur: number, amp: number) {
  const s = Math.round(start * SAMPLE_RATE);
  const n = Math.round(dur * SAMPLE_RATE);
  for (let i = 0; i < n && s + i < x.length; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.min(1, i / 160, (n - i) / 160);
    x[s + i] += env * amp * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(4 * Math.PI * f0 * t) + 0.25 * Math.sin(6 * Math.PI * f0 * t));
  }
}

describe('estimatePitch', () => {
  it.each([120, 180, 230, 320, 420, 600])('finds %d Hz within 5%%', (f0) => {
    const x = makeTrack(0.2, 0);
    addVoice(x, f0, 0, 0.2, 0.1);
    const est = estimatePitch(x, 800);
    expect(est).not.toBeNull();
    expect(Math.abs((est as number) - f0) / f0).toBeLessThan(0.05);
  });

  it('returns null for noise', () => {
    const x = makeTrack(0.2, 0.1);
    expect(estimatePitch(x, 800)).toBeNull();
  });
});

describe('analyzeAudio', () => {
  it('measures parent response latency after child vocal bids', () => {
    const x = makeTrack(30);
    for (const t of [1, 5, 9, 13]) {
      addVoice(x, 400, t, 0.8, 0.03); // 아이
      addVoice(x, 150, t + 0.8 + 1.0, 1.0, 0.03); // 1초 뒤 어른
    }
    const { metrics } = analyzeAudio(x);
    expect(metrics.childBidCount).toBe(4);
    expect(metrics.respondedBidCount).toBe(4);
    expect(metrics.responseLatencySec).not.toBeNull();
    expect(Math.abs((metrics.responseLatencySec as number) - 1.0)).toBeLessThan(0.15);
    expect(metrics.distressEpisodeCount).toBe(0);
  });

  it('returns null latency when fewer than three bids are answered', () => {
    const x = makeTrack(20);
    addVoice(x, 400, 1, 0.8, 0.03);
    addVoice(x, 150, 2.5, 1, 0.03);
    addVoice(x, 400, 8, 0.8, 0.03); // 응답 없음
    const { metrics } = analyzeAudio(x);
    expect(metrics.childBidCount).toBe(2);
    expect(metrics.respondedBidCount).toBe(1);
    expect(metrics.responseLatencySec).toBeNull();
  });

  it('counts long loud high-pitched episodes and merges close ones', () => {
    const x = makeTrack(40);
    addVoice(x, 450, 5, 3, 0.4); // 울음 1
    addVoice(x, 470, 9, 2, 0.4); // 1초 뒤 다시 → 같은 에피소드
    addVoice(x, 450, 25, 2.5, 0.4); // 울음 2
    addVoice(x, 450, 33, 0.8, 0.4); // 짧음 → 세지 않음
    const { metrics } = analyzeAudio(x);
    expect(metrics.distressEpisodeCount).toBe(2);
  });

  it('handles silence', () => {
    const { metrics } = analyzeAudio(makeTrack(12, 0.0005));
    expect(metrics).toEqual({ childBidCount: 0, respondedBidCount: 0, responseLatencySec: null, distressEpisodeCount: 0 });
  });
});

function body(cx: number, cy: number, torso: number): Landmark[] {
  const lm: Landmark[] = Array.from({ length: 33 }, () => ({ x: 0, y: 0, visibility: 0 }));
  const half = torso / 2;
  lm[11] = { x: cx - 0.05, y: cy - half, visibility: 1 };
  lm[12] = { x: cx + 0.05, y: cy - half, visibility: 1 };
  lm[23] = { x: cx - 0.04, y: cy + half, visibility: 1 };
  lm[24] = { x: cx + 0.04, y: cy + half, visibility: 1 };
  return lm;
}

describe('pose joint play', () => {
  const W = 640;
  const H = 640;

  it('treats two nearby people as together', () => {
    const a = personFromLandmarks(body(0.4, 0.5, 0.3), W, H)!;
    const b = personFromLandmarks(body(0.6, 0.55, 0.2), W, H)!;
    expect(isTogether([a, b])).toBe(true);
  });

  it('treats far apart or single person as not together', () => {
    const a = personFromLandmarks(body(0.1, 0.5, 0.08), W, H)!;
    const b = personFromLandmarks(body(0.9, 0.5, 0.08), W, H)!;
    expect(isTogether([a, b])).toBe(false);
    expect(isTogether([a])).toBe(false);
  });

  it('ignores people whose shoulders are not visible', () => {
    const lm = body(0.5, 0.5, 0.3);
    lm[11].visibility = 0.1;
    expect(personFromLandmarks(lm, W, H)).toBeNull();
  });

  it('counts seconds and fills one-frame gaps', () => {
    expect(jointPlaySeconds([true, true, false, true, false, false, true])).toBe(2.5);
  });
});
