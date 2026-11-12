import { describe, expect, it } from 'vitest';
import { nextVideoTimestamp, untilStopped, VIDEO_TIMESTAMP_GAP_MS, videoTimestampBase } from './analyzeVideo';

const STEP = 0.5;

/** analyzeVideo의 프레임 반복과 같은 방식으로 한 번의 분석에서 넘길 타임스탬프들을 만든다. */
function runOnce(lastMs: number, durationSec: number): { stamps: number[]; last: number } {
  const base = videoTimestampBase(lastMs);
  const stamps: number[] = [];
  let last = lastMs;
  const steps = Math.floor(durationSec / STEP);
  for (let i = 0; i < steps; i++) {
    last = nextVideoTimestamp(last, base, i * STEP);
    stamps.push(last);
  }
  return { stamps, last };
}

function expectStrictlyIncreasing(values: number[]) {
  for (let i = 1; i < values.length; i++) expect(values[i]).toBeGreaterThan(values[i - 1]);
}

describe('video timestamps', () => {
  it('starts above the last timestamp handed to the landmarker, with a gap between runs', () => {
    expect(videoTimestampBase(0)).toBe(10001);
    expect(videoTimestampBase(11501001)).toBe(11511002);
    expect(videoTimestampBase(1234.7)).toBe(1234 + 1 + VIDEO_TIMESTAMP_GAP_MS);
  });

  it('leaves a gap much larger than one frame step between consecutive runs', () => {
    const first = runOnce(0, 11.5);
    const second = runOnce(first.last, 10);
    expect(second.stamps[0] - first.last).toBeGreaterThan(VIDEO_TIMESTAMP_GAP_MS);
    expect(VIDEO_TIMESTAMP_GAP_MS).toBeGreaterThan(STEP * 1000 * 10);
  });

  it('is strictly increasing within one run', () => {
    const { stamps } = runOnce(0, 60);
    expect(stamps[0]).toBe(10001);
    expect(stamps).toHaveLength(120);
    expectStrictlyIncreasing(stamps);
  });

  it('keeps increasing across consecutive runs in the same page', () => {
    let last = 0;
    const all: number[] = [];
    for (const duration of [11.5, 30, 10, 180.4, 12]) {
      const run = runOnce(last, duration);
      expect(run.stamps[0]).toBeGreaterThan(last);
      all.push(...run.stamps);
      last = run.last;
    }
    expectStrictlyIncreasing(all);
  });

  it('a second run never goes back to the start of the video', () => {
    const first = runOnce(0, 1800);
    const second = runOnce(first.last, 20);
    expect(second.stamps[0]).toBeGreaterThan(first.last);
    expect(second.stamps[second.stamps.length - 1]).toBeGreaterThan(first.last + 19000);
  });

  it('still moves forward when the same position is used twice', () => {
    const base = videoTimestampBase(500);
    const a = nextVideoTimestamp(500, base, 0);
    const b = nextVideoTimestamp(a, base, 0);
    const c = nextVideoTimestamp(b, base, 0.0004);
    expect(a).toBeGreaterThan(500);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
  });

  it('stays increasing when two runs interleave on one landmarker', () => {
    let last = 0;
    const baseA = videoTimestampBase(last);
    const baseB = videoTimestampBase(last);
    const all: number[] = [];
    for (let i = 0; i < 20; i++) {
      last = nextVideoTimestamp(last, baseA, i * STEP);
      all.push(last);
      last = nextVideoTimestamp(last, baseB, i * STEP);
      all.push(last);
    }
    expectStrictlyIncreasing(all);
  });

  it('returns whole milliseconds', () => {
    const { stamps } = runOnce(1234.7, 15);
    for (const s of stamps) expect(Number.isInteger(s)).toBe(true);
  });
});

describe('untilStopped', () => {
  it('passes the result through when not stopped', async () => {
    const ctrl = new AbortController();
    await expect(untilStopped(Promise.resolve(3), ctrl.signal)).resolves.toBe(3);
  });

  it('ends right away when stopped while waiting, without leaving an unhandled rejection', async () => {
    const ctrl = new AbortController();
    let fail: (e: Error) => void = () => undefined;
    const work = new Promise<number>((_, reject) => {
      fail = reject;
    });
    const waiting = untilStopped(work, ctrl.signal);
    ctrl.abort();
    await expect(waiting).rejects.toThrow('분석을 멈췄어요.');
    // 남은 작업이 나중에 실패해도 처리되지 않은 거부가 생기지 않아야 한다(vitest가 잡아낸다).
    fail(new Error('late'));
    await new Promise((r) => setTimeout(r, 0));
  });

  it('rejects immediately when already stopped', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(untilStopped(Promise.reject(new Error('late')), ctrl.signal)).rejects.toThrow('분석을 멈췄어요.');
  });
});
