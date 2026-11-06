/**
 * 오디오 지표 계산 (지표 정의서 metrics-v1, docs/metrics.md 1·2장).
 * 입력은 기기 안에서 디코딩한 16kHz 모노 샘플이며, 이 모듈은 네트워크를 쓰지 않는다.
 */

export const SAMPLE_RATE = 16000;
const WIN = 640; // 40ms
const HOP = 320; // 20ms
const FRAME_SEC = HOP / SAMPLE_RATE;
const MIN_F0 = 75;
const MAX_F0 = 1000;
const CLARITY_MIN = 0.5;

export const CHILD_MIN_F0 = 280;
export const ADULT_MIN_F0 = 85;
export const ADULT_MAX_F0 = 255;

export type Speaker = 'child' | 'adult';

export interface Segment {
  speaker: Speaker;
  start: number; // 초
  end: number; // 초
}

export interface AudioMetrics {
  childBidCount: number;
  respondedBidCount: number;
  responseLatencySec: number | null;
  distressEpisodeCount: number;
}

interface Frame {
  t: number;
  db: number;
  f0: number | null;
}

/** 정규화 자기상관으로 기본 주파수를 추정한다. 주기성이 약하면 null. */
export function estimatePitch(x: Float32Array, offset: number, sampleRate = SAMPLE_RATE): number | null {
  const minLag = Math.floor(sampleRate / MAX_F0);
  const maxLag = Math.min(Math.ceil(sampleRate / MIN_F0), WIN - 1);
  const corr = new Float32Array(maxLag + 1);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    const n = WIN - lag;
    for (let i = 0; i < n; i++) {
      const a = x[offset + i];
      const b = x[offset + i + lag];
      sxy += a * b;
      sxx += a * a;
      syy += b * b;
    }
    const r = sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
    corr[lag] = r;
    if (r > best) best = r;
  }
  if (best < CLARITY_MIN) return null;
  // 배수 주기(옥타브 아래)로 잘못 잡지 않도록, 최고값의 90% 이상인 첫 봉우리를 쓴다.
  for (let lag = minLag + 1; lag < maxLag; lag++) {
    if (corr[lag] >= best * 0.9 && corr[lag] >= corr[lag - 1] && corr[lag] >= corr[lag + 1]) {
      return sampleRate / lag;
    }
  }
  return null;
}

function frames(samples: Float32Array): Frame[] {
  const out: Frame[] = [];
  for (let off = 0; off + WIN <= samples.length; off += HOP) {
    let s = 0;
    for (let i = 0; i < WIN; i++) s += samples[off + i] * samples[off + i];
    const rms = Math.sqrt(s / WIN);
    out.push({ t: off / SAMPLE_RATE, db: 20 * Math.log10(rms + 1e-9), f0: null });
  }
  return out;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return -120;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** 같은 표시를 가진 프레임을 시간 구간으로 묶는다. */
function mergeFrames(times: number[], maxGap: number, minLen: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = -1;
  let last = -1;
  for (const t of times) {
    if (start < 0) {
      start = t;
    } else if (t - last > maxGap + FRAME_SEC / 2) {
      out.push([start, last + WIN / SAMPLE_RATE]);
      start = t;
    }
    last = t;
  }
  if (start >= 0) out.push([start, last + WIN / SAMPLE_RATE]);
  return out.filter(([s, e]) => e - s >= minLen);
}

export interface AudioAnalysis {
  metrics: AudioMetrics;
  segments: Segment[];
  distressEpisodes: Array<[number, number]>;
}

export function analyzeAudio(samples: Float32Array): AudioAnalysis {
  const fs = frames(samples);
  const floor = percentile(
    fs.map((f) => f.db),
    0.2,
  );
  const voiceDb = floor + 10;
  const loudDb = floor + 25;

  const childTimes: number[] = [];
  const adultTimes: number[] = [];
  const loudChildTimes: number[] = [];
  fs.forEach((f, idx) => {
    if (f.db <= voiceDb) return;
    f.f0 = estimatePitch(samples, idx * HOP);
    if (f.f0 == null) return;
    if (f.f0 >= CHILD_MIN_F0) {
      childTimes.push(f.t);
      if (f.db >= loudDb) loudChildTimes.push(f.t);
    } else if (f.f0 >= ADULT_MIN_F0 && f.f0 <= ADULT_MAX_F0) {
      adultTimes.push(f.t);
    }
  });

  const child = mergeFrames(childTimes, 0.2, 0.2).map(([s, e]) => ({ speaker: 'child' as const, start: s, end: e }));
  const adult = mergeFrames(adultTimes, 0.2, 0.2).map(([s, e]) => ({ speaker: 'adult' as const, start: s, end: e }));

  // 울음·감정 폭발: 크고 높은 아이 소리가 1.5초 이상. 3초 안에 다시 이어지면 한 번으로 센다.
  const loud = mergeFrames(loudChildTimes, 0.5, 1.5);
  const episodes: Array<[number, number]> = [];
  for (const seg of loud) {
    const prev = episodes[episodes.length - 1];
    if (prev && seg[0] - prev[1] <= 3) prev[1] = seg[1];
    else episodes.push([seg[0], seg[1]]);
  }

  // 아이 발화(울음 구간 제외, 0.3초 이상)와 부모 반응
  const bids = child.filter(
    (c) => c.end - c.start >= 0.3 && !episodes.some(([s, e]) => c.start < e && c.end > s),
  );
  const latencies: number[] = [];
  for (const bid of bids) {
    const reply = adult.find((a) => a.start >= bid.start + 0.2 && a.start <= bid.end + 5);
    if (reply) latencies.push(Math.max(0, reply.start - bid.end));
  }
  latencies.sort((a, b) => a - b);
  const median =
    latencies.length < 3
      ? null
      : latencies.length % 2
        ? latencies[(latencies.length - 1) / 2]
        : (latencies[latencies.length / 2 - 1] + latencies[latencies.length / 2]) / 2;

  return {
    metrics: {
      childBidCount: bids.length,
      respondedBidCount: latencies.length,
      responseLatencySec: median == null ? null : Math.round(Math.min(10, median) * 100) / 100,
      distressEpisodeCount: episodes.length,
    },
    segments: [...child, ...adult].sort((a, b) => a.start - b.start),
    distressEpisodes: episodes,
  };
}
