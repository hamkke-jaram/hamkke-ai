// 소리 지표의 '알려진 한계'(T-003 3.1 A1~A5)를 지금 값 그대로 고정한다.
// 정의서(docs/metrics.md)대로 계산한 결과이고, 실제 소리에서는 틀린 값이다. 지표 정의를 바꾸면(specVersion 올림)
// 이 테스트가 깨지는 것이 정상이다 — 그때 기대값을 새 정의에 맞게 고친다.
// 함께 끝값(무음·아주 짧음·클리핑·빈 입력)에서 NaN·음수·무한대가 나오지 않는지 본다.
import { describe, expect, it } from 'vitest';
import { SAMPLE_RATE, analyzeAudio } from './audio';
import type { AudioMetrics } from './audio';

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

/** 배음이 있는 목소리 비슷한 소리(analysis.test.ts 와 같은 방식). */
function addVoice(x: Float32Array, f0: number, start: number, dur: number, amp: number) {
  const s = Math.round(start * SAMPLE_RATE);
  const n = Math.round(dur * SAMPLE_RATE);
  for (let i = 0; i < n && s + i < x.length; i++) {
    const t = i / SAMPLE_RATE;
    const env = Math.min(1, i / 160, (n - i) / 160);
    x[s + i]! += env * amp * (Math.sin(2 * Math.PI * f0 * t) + 0.5 * Math.sin(4 * Math.PI * f0 * t) + 0.25 * Math.sin(6 * Math.PI * f0 * t));
  }
}

/** 0.5초마다 바뀌는 화음(배경 음악 흉내). */
function addMusic(x: Float32Array, amp: number) {
  const notes = [262, 330, 392, 523];
  for (let i = 0; i < x.length; i++) {
    const t = i / SAMPLE_RATE;
    const note = notes[Math.floor(t * 2) % notes.length]!;
    x[i]! += amp * (Math.sin(2 * Math.PI * note * t) + 0.6 * Math.sin(2 * Math.PI * note * 1.5 * t));
  }
}

function sane(m: AudioMetrics) {
  for (const v of [m.childBidCount, m.respondedBidCount, m.distressEpisodeCount]) {
    expect(Number.isInteger(v)).toBe(true);
    expect(v).toBeGreaterThanOrEqual(0);
  }
  expect(m.respondedBidCount).toBeLessThanOrEqual(m.childBidCount);
  if (m.responseLatencySec !== null) {
    expect(Number.isFinite(m.responseLatencySec)).toBe(true);
    expect(m.responseLatencySec).toBeGreaterThanOrEqual(0);
  }
}

describe('알려진 한계 (T-003 A1~A5, 정의서대로 계산한 지금 값)', () => {
  it('A1: 조용한 방에서는 보통 크기의 아이 소리 2초가 울음 1번이 되고 발화로는 세지 않는다', () => {
    const quiet = makeTrack(30, 0.0005);
    addVoice(quiet, 400, 5, 2, 0.03);
    const normal = makeTrack(30, 0.003);
    addVoice(normal, 400, 5, 2, 0.03);
    const q = analyzeAudio(quiet).metrics;
    const n = analyzeAudio(normal).metrics;
    expect([q.distressEpisodeCount, q.childBidCount]).toEqual([1, 0]);
    expect([n.distressEpisodeCount, n.childBidCount]).toEqual([0, 1]); // 같은 소리, 보통 방
  });

  it('A2: 울음이 아닌 크고 높은 소리(웃음·노래) 2초도 울음 1번이다', () => {
    const x = makeTrack(30);
    addVoice(x, 500, 5, 2, 0.3);
    expect(analyzeAudio(x).metrics.distressEpisodeCount).toBe(1);
  });

  it('A3: 어른이 320Hz 로 답하면 아이 발화로 세어 발화 8, 반응 0 이다(265Hz 는 구분하지 않아 반응 0)', () => {
    const high = makeTrack(30);
    const middle = makeTrack(30);
    for (const t of [1, 6, 11, 16]) {
      addVoice(high, 400, t, 0.8, 0.03);
      addVoice(high, 320, t + 1.8, 1, 0.03);
      addVoice(middle, 400, t, 0.8, 0.03);
      addVoice(middle, 265, t + 1.8, 1, 0.03);
    }
    const h = analyzeAudio(high).metrics;
    const m = analyzeAudio(middle).metrics;
    expect([h.childBidCount, h.respondedBidCount, h.responseLatencySec]).toEqual([8, 0, null]);
    expect([m.childBidCount, m.respondedBidCount, m.responseLatencySec]).toEqual([4, 0, null]);
  });

  it('A4: 배경 음악이 깔리면 실제 발화 4·반응 4 를 모두 놓쳐 0 이 된다(null 이 아니라 0)', () => {
    const x = makeTrack(30);
    addMusic(x, 0.05);
    for (const t of [1, 6, 11, 16]) {
      addVoice(x, 400, t, 0.8, 0.03);
      addVoice(x, 150, t + 1.8, 1, 0.03);
    }
    const m = analyzeAudio(x).metrics;
    expect([m.childBidCount, m.respondedBidCount, m.responseLatencySec]).toEqual([0, 0, null]);
  });

  it('A5: 아이가 3번 연달아 말하고 어른이 1번 답하면 그 한 번을 세 발화의 반응으로 겹쳐 센다', () => {
    const x = makeTrack(30);
    for (const t of [1, 2.5, 4]) addVoice(x, 400, t, 0.8, 0.03);
    addVoice(x, 150, 5.5, 1, 0.03);
    const m = analyzeAudio(x).metrics;
    expect([m.childBidCount, m.respondedBidCount]).toEqual([3, 3]);
  });
});

describe('끝값에서도 숫자가 망가지지 않는다', () => {
  const cases: Array<[string, () => Float32Array]> = [
    ['빈 입력', () => new Float32Array(0)],
    ['0.1초', () => makeTrack(0.1)],
    ['1초 잡음', () => makeTrack(1)],
    ['30초 완전 무음(모두 0)', () => new Float32Array(30 * SAMPLE_RATE)],
    ['30초 클리핑 잡음(±1)', () => {
      const r = rng(7);
      const x = new Float32Array(30 * SAMPLE_RATE);
      for (let i = 0; i < x.length; i++) x[i] = Math.sign(r()) || 1;
      return x;
    }],
    ['30초 음악만', () => {
      const x = makeTrack(30);
      addMusic(x, 0.2);
      return x;
    }],
  ];

  it.each(cases)('%s: 발화·울음 0, 반응 시간 null', (_name, make) => {
    const m = analyzeAudio(make()).metrics;
    sane(m);
    expect(m).toEqual({ childBidCount: 0, respondedBidCount: 0, responseLatencySec: null, distressEpisodeCount: 0 });
  });
});
