// VL 관찰 기록 평가 도구(server/eval/harness.ts). 가짜 제공자로 확인한다.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CSV_HEADER, LabelError, compareTags, parseLabels, runClip, summarise, textStats, toCsv } from '../eval/harness.ts';
import type { LabelClip } from '../eval/harness.ts';
import { ProviderUnavailableError } from '../src/provider.ts';
import { EVALUATIVE_TERMS } from '../src/wording.ts';
import { GOOD_OUTPUT, fakeProvider, makeJpeg } from './helpers.ts';

const CLIP: LabelClip = {
  id: 'staged-01',
  durationSec: 30,
  frames: [
    { t: 0, file: 'a.jpg' },
    { t: 10, file: 'b.jpg' },
  ],
  expected: { childStates: ['PLAYING_TOGETHER', 'UPSET_CRYING'], adultResponses: ['WAITING'], peopleCount: 2 },
};

const FRAMES = [
  { t: 10, jpeg: makeJpeg() },
  { t: 0, jpeg: makeJpeg() },
];

describe('라벨 파일', () => {
  it('예시 파일을 읽을 수 있다', () => {
    const example = JSON.parse(readFileSync(new URL('../eval/vl-labels.example.json', import.meta.url), 'utf8')) as unknown;
    const clips = parseLabels(example);
    expect(clips.map((c) => c.id)).toEqual(['staged-01-blocks', 'staged-02-empty-room']);
    expect(clips[0]!.frames).toHaveLength(6);
    expect(clips[1]!.expected).toEqual({ childStates: [], adultResponses: [], peopleCount: 0 });
  });

  it('목록에 없는 태그, 겹친 id, 잘못된 장수는 거절한다', () => {
    const clip = (overrides: Record<string, unknown>) => ({
      id: 'a',
      frames: [{ t: 0, file: 'a.jpg' }],
      expected: { childStates: [], adultResponses: [] },
      ...overrides,
    });
    expect(() => parseLabels({})).toThrowError(LabelError);
    expect(() => parseLabels({ clips: [clip({ expected: { childStates: ['NOT_A_TAG'] } })] })).toThrowError(LabelError);
    expect(() => parseLabels({ clips: [clip({}), clip({})] })).toThrowError(LabelError);
    expect(() => parseLabels({ clips: [clip({ frames: [] })] })).toThrowError(LabelError);
    expect(() => parseLabels({ clips: [clip({ id: '../x' })] })).toThrowError(LabelError);
    expect(() => parseLabels({ clips: [clip({ expected: { peopleCount: 5 } })] })).toThrowError(LabelError);
  });
});

describe('태그 비교와 글 통계', () => {
  it('일치·놓침·더함', () => {
    expect(compareTags(['A', 'B'], ['B', 'C'])).toEqual({ matched: ['B'], missed: ['A'], extra: ['C'] });
  });

  it('문장 검사에 걸린 글과 버려진 글, 목록에 없는 태그를 센다', () => {
    const raw = {
      summary: `아이가 블록을 쌓아요. ${EVALUATIVE_TERMS[0]}가 보여요.`,
      childStates: ['PLAYING_ALONE', 'MADE_UP'],
      adultResponses: [],
      moments: [
        { t: 0, note: '아이가 블록을 쌓아요.' },
        { t: 10, note: 'The child stacks blocks.' },
      ],
      peopleCount: 1,
    };
    const stats = textStats(raw, {
      summary: null,
      childStates: ['PLAYING_ALONE'],
      adultResponses: [],
      moments: [{ t: 0, note: '아이가 블록을 쌓아요.' }],
      peopleCount: 1,
    });
    expect(stats).toEqual({ written: 3, wordingRejected: 1, dropped: 2, invalidTags: 1 });
  });
});

describe('클립 하나 돌리기', () => {
  it('서버와 같은 순서로 처리하고 사람 라벨과 비교한다', async () => {
    const provider = fakeProvider();
    let ms = 1_000;
    const result = await runClip(provider, CLIP, FRAMES, 5_000, () => (ms += 250));
    expect(result).toMatchObject({
      id: 'staged-01',
      outcome: 'ok',
      attempts: 1,
      ms: 250,
      model: 'fake-vl:1',
      childStates: { matched: ['PLAYING_TOGETHER'], missed: ['UPSET_CRYING'], extra: ['REFUSING'] },
      adultResponses: { matched: ['WAITING'], missed: [], extra: ['TALKING'] },
      peopleExpected: 2,
      peopleGot: 2,
      text: { written: 2, wordingRejected: 0, dropped: 0, invalidTags: 0 },
      summary: GOOD_OUTPUT.summary,
    });
    // 사진은 시각 순서로, 시각은 요청문에 적혀 모델에 간다.
    expect(provider.calls[0]!.images).toHaveLength(2);
    expect(provider.calls[0]!.user).toContain('- 사진 2: t=10');
  });

  it('쓸 수 없는 출력은 한 번 더 부르고, 그래도 안 되면 bad_output', async () => {
    const result = await runClip(fakeProvider(['글', '{"peopleCount":"two"}']), CLIP, FRAMES, 5_000);
    expect([result.outcome, result.attempts]).toEqual(['bad_output', 2]);
    expect(result.childStates.missed).toEqual(['PLAYING_TOGETHER', 'UPSET_CRYING']);
  });

  it('모델 서버에 닿지 못하면 짧은 코드, 대신 쓴 모델이면 그 이름', async () => {
    const down = await runClip(fakeProvider([new ProviderUnavailableError('connect')]), CLIP, FRAMES, 5_000);
    expect(down.outcome).toBe('unavailable:connect');

    const provider = fakeProvider();
    const generate = provider.generate.bind(provider);
    provider.generate = async (request) => ({ text: (await generate(request)) as string, modelVersion: 'small-vl:1' });
    expect((await runClip(provider, CLIP, FRAMES, 5_000)).model).toBe('small-vl:1');
  });

  it('JPEG 가 아니면 모델을 부르지 않는다', async () => {
    const provider = fakeProvider();
    const result = await runClip(provider, CLIP, [{ t: 0, jpeg: Buffer.from('not a jpeg') }], 5_000);
    expect(result.outcome).toBe('invalid_frames:not_jpeg');
    expect(provider.calls).toHaveLength(0);
  });
});

describe('모아 보기와 CSV', () => {
  it('ok 클립만 태그 비교에 넣고 precision·recall 을 계산한다', async () => {
    const ok = await runClip(fakeProvider(), CLIP, FRAMES, 5_000);
    const failed = await runClip(fakeProvider([new ProviderUnavailableError('connect')]), CLIP, FRAMES, 5_000);
    const totals = summarise([ok, failed]);
    expect(totals).toMatchObject({ clips: 2, ok: 1, peopleMatched: 1, peopleLabelled: 1, retried: 1 });
    expect(totals.allTags).toEqual({ matched: 2, missed: 1, extra: 2, precision: 0.5, recall: 2 / 3 });
    expect(totals.childStates.precision).toBe(0.5);
  });

  it('CSV 에는 태그 이름과 숫자만 있고 문장은 없다', async () => {
    const ok = await runClip(fakeProvider(), CLIP, FRAMES, 5_000);
    const csv = toCsv([ok]);
    const [head, row] = csv.trim().split('\n');
    expect(head).toBe(CSV_HEADER.join(','));
    expect(row).toContain('staged-01,ok,1,');
    expect(row).toContain('UPSET_CRYING');
    expect(csv).not.toContain(GOOD_OUTPUT.summary);
    expect(csv).not.toContain(GOOD_OUTPUT.moments[0]!.note);
  });
});
