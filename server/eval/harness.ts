// VL 관찰 기록 품질 평가의 계산 부분(파일·네트워크 없음). CLI 는 vl-eval.ts.
// 사람이 붙인 태그(라벨)와 모델이 붙인 태그를 비교해 일치·놓침·더함 수를 센다.
// 결과는 내부 개선용이다. 앱·발표 자료에 퍼센트 수치로 쓰지 않는다.
import { FrameError, parseAnalyzeBody } from '../src/frames.ts';
import { ADULT_RESPONSES, CHILD_STATES, normaliseObservation, parseModelJson } from '../src/observation.ts';
import type { Observation } from '../src/observation.ts';
import { buildPrompt } from '../src/prompt.ts';
import { ProviderTimeoutError, ProviderUnavailableError, toVisionOutput } from '../src/provider.ts';
import type { VisionProvider } from '../src/provider.ts';
import { passesWordingCheck } from '../src/wording.ts';

/** 서버와 같은 횟수만큼 불러 본다(app.ts MODEL_ATTEMPTS). */
export const EVAL_ATTEMPTS = 2;

export interface LabelFrame {
  t: number;
  /** 라벨 파일이 있는 폴더 기준 상대 경로. */
  file: string;
}

export interface ExpectedTags {
  childStates: string[];
  adultResponses: string[];
  peopleCount?: number;
}

export interface LabelClip {
  id: string;
  durationSec: number | null;
  frames: LabelFrame[];
  expected: ExpectedTags;
}

export class LabelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabelError';
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tagList(value: unknown, allowed: readonly string[], where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new LabelError(`${where}: 태그는 배열로 적어 주세요.`);
  const tags: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !allowed.includes(item)) {
      throw new LabelError(`${where}: 목록에 없는 태그예요 → ${String(item)}`);
    }
    if (!tags.includes(item)) tags.push(item);
  }
  return tags;
}

/** 라벨 JSON 을 읽어 검사한다. 형식은 server/eval/README.md 와 vl-labels.example.json. */
export function parseLabels(data: unknown): LabelClip[] {
  if (!isPlainObject(data) || !Array.isArray(data.clips)) throw new LabelError('라벨 파일에 clips 배열이 필요해요.');
  const ids = new Set<string>();
  return data.clips.map((clip, index) => {
    const where = `clips[${index}]`;
    if (!isPlainObject(clip)) throw new LabelError(`${where}: 객체가 아니에요.`);
    if (typeof clip.id !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(clip.id)) {
      throw new LabelError(`${where}: id 는 영문·숫자·.-_ 로 된 64자 이하 이름이어야 해요.`);
    }
    if (ids.has(clip.id)) throw new LabelError(`${where}: id 가 겹쳐요 → ${clip.id}`);
    ids.add(clip.id);
    if (!Array.isArray(clip.frames) || clip.frames.length < 1 || clip.frames.length > 6) {
      throw new LabelError(`${clip.id}: frames 는 1~6장이어야 해요.`);
    }
    const frames = clip.frames.map((frame, i) => {
      if (!isPlainObject(frame) || typeof frame.t !== 'number' || !(frame.t >= 0) || typeof frame.file !== 'string') {
        throw new LabelError(`${clip.id}: frames[${i}] 에 t(초)와 file 이 필요해요.`);
      }
      return { t: frame.t, file: frame.file };
    });
    const durationSec = typeof clip.durationSec === 'number' && clip.durationSec > 0 ? clip.durationSec : null;
    const expected = isPlainObject(clip.expected) ? clip.expected : {};
    const peopleCount = expected.peopleCount;
    if (peopleCount !== undefined && (typeof peopleCount !== 'number' || ![0, 1, 2, 3].includes(peopleCount))) {
      throw new LabelError(`${clip.id}: expected.peopleCount 는 0~3 이어야 해요.`);
    }
    return {
      id: clip.id,
      durationSec,
      frames,
      expected: {
        childStates: tagList(expected.childStates, CHILD_STATES, `${clip.id}.childStates`),
        adultResponses: tagList(expected.adultResponses, ADULT_RESPONSES, `${clip.id}.adultResponses`),
        ...(peopleCount === undefined ? {} : { peopleCount }),
      },
    };
  });
}

export interface TagComparison {
  matched: string[];
  missed: string[];
  extra: string[];
}

export function compareTags(expected: readonly string[], got: readonly string[]): TagComparison {
  return {
    matched: expected.filter((tag) => got.includes(tag)),
    missed: expected.filter((tag) => !got.includes(tag)),
    extra: got.filter((tag) => !expected.includes(tag)),
  };
}

/** 모델이 쓴 날것의 출력에서 문장 검사에 걸린 글 수와, 다듬기에서 버려진 글 수를 센다. */
export interface TextStats {
  /** 모델이 쓴 글(summary + note) 수. */
  written: number;
  /** 문장 검사(금지·평가·조언·추측·나이·생김새 표현)에 걸린 글 수. */
  wordingRejected: number;
  /** 최종 기록에 남지 못한 글 수(문장 검사 + 해요체 아님 + 한국어 아님 등). */
  dropped: number;
  /** 목록에 없는 태그 수. */
  invalidTags: number;
}

export function textStats(raw: unknown, observation: Observation | null): TextStats {
  const stats: TextStats = { written: 0, wordingRejected: 0, dropped: 0, invalidTags: 0 };
  if (!isPlainObject(raw)) return stats;
  const texts: string[] = [];
  if (typeof raw.summary === 'string' && raw.summary.trim() !== '') texts.push(raw.summary);
  let notes = 0;
  if (Array.isArray(raw.moments)) {
    for (const moment of raw.moments) {
      if (isPlainObject(moment) && typeof moment.note === 'string' && moment.note.trim() !== '') {
        texts.push(moment.note);
        notes++;
      }
    }
  }
  stats.written = texts.length;
  stats.wordingRejected = texts.filter((text) => !passesWordingCheck(text.replace(/\s+/g, ' '))).length;
  const keptSummary = observation?.summary ? 1 : 0;
  const hadSummary = typeof raw.summary === 'string' && raw.summary.trim() !== '' ? 1 : 0;
  const keptNotes = observation?.moments.length ?? 0;
  stats.dropped = hadSummary - keptSummary + Math.max(0, notes - keptNotes);
  const invalid = (value: unknown, allowed: readonly string[]): number =>
    Array.isArray(value) ? value.filter((tag) => typeof tag !== 'string' || !allowed.includes(tag)).length : 0;
  stats.invalidTags = invalid(raw.childStates, CHILD_STATES) + invalid(raw.adultResponses, ADULT_RESPONSES);
  return stats;
}

export interface ClipResult {
  id: string;
  /** ok | bad_output | timeout | unavailable:<짧은 코드> | invalid_frames:<짧은 코드> */
  outcome: string;
  attempts: number;
  ms: number;
  model: string | null;
  childStates: TagComparison;
  adultResponses: TagComparison;
  peopleExpected: number | null;
  peopleGot: number | null;
  text: TextStats;
  /** 사람이 비교해 볼 수 있게 남기는 최종 요약 문장. CLI 가 --show-text 일 때만 보여 준다(CSV 에는 넣지 않는다). */
  summary: string | null;
}

const EMPTY_TEXT: TextStats = { written: 0, wordingRejected: 0, dropped: 0, invalidTags: 0 };

/**
 * 한 클립을 서버와 같은 순서로 처리한다: 사진 검사 → 프롬프트 → 모델(최대 2번) → 해석·다듬기 → 비교.
 * frames 는 JPEG 바이트. 이 함수는 사진을 저장하거나 출력하지 않는다.
 */
export async function runClip(
  provider: VisionProvider,
  clip: LabelClip,
  frames: readonly { t: number; jpeg: Buffer }[],
  timeoutMs: number,
  now: () => number = Date.now,
): Promise<ClipResult> {
  const started = now();
  const base: ClipResult = {
    id: clip.id,
    outcome: 'ok',
    attempts: 0,
    ms: 0,
    model: null,
    childStates: compareTags(clip.expected.childStates, []),
    adultResponses: compareTags(clip.expected.adultResponses, []),
    peopleExpected: clip.expected.peopleCount ?? null,
    peopleGot: null,
    text: { ...EMPTY_TEXT },
    summary: null,
  };

  let images: string[];
  let frameTimes: number[];
  try {
    const body = Buffer.from(
      JSON.stringify({ frames: frames.map((f) => ({ t: f.t, jpeg: f.jpeg.toString('base64') })), durationSec: clip.durationSec }),
      'utf8',
    );
    const input = parseAnalyzeBody(body);
    images = input.frames.map((f) => f.jpeg);
    frameTimes = input.frames.map((f) => f.t);
  } catch (err) {
    return { ...base, outcome: `invalid_frames:${err instanceof FrameError ? err.reason : 'unknown'}`, ms: now() - started };
  }

  const prompt = buildPrompt(frameTimes, clip.durationSec);
  const deadline = AbortSignal.timeout(timeoutMs);
  let outcome = 'bad_output';
  try {
    for (let attempt = 1; attempt <= EVAL_ATTEMPTS; attempt++) {
      base.attempts = attempt;
      let text: string;
      let model: string;
      try {
        ({ text, modelVersion: model } = toVisionOutput(
          await provider.generate({ ...prompt, images, signal: deadline }),
          provider.modelVersion,
        ));
      } catch (err) {
        if (deadline.aborted || err instanceof ProviderTimeoutError) {
          outcome = 'timeout';
          break;
        }
        outcome = `unavailable:${err instanceof ProviderUnavailableError ? err.detail : 'provider_error'}`;
        continue;
      }
      const raw = parseModelJson(text);
      const observation = normaliseObservation(raw, frameTimes);
      base.text = textStats(raw, observation);
      base.model = model;
      if (observation === null) {
        outcome = 'bad_output';
        continue;
      }
      return {
        ...base,
        outcome: 'ok',
        ms: now() - started,
        childStates: compareTags(clip.expected.childStates, observation.childStates),
        adultResponses: compareTags(clip.expected.adultResponses, observation.adultResponses),
        peopleGot: observation.peopleCount,
        summary: observation.summary,
      };
    }
    return { ...base, outcome, ms: now() - started };
  } finally {
    images.length = 0;
  }
}

export interface GroupTotals {
  matched: number;
  missed: number;
  extra: number;
  /** 모델이 붙인 태그 가운데 사람 라벨과 같은 비율(precision). 붙인 태그가 없으면 null. */
  precision: number | null;
  /** 사람 라벨 가운데 모델도 붙인 비율(recall). 라벨이 없으면 null. */
  recall: number | null;
}

export interface Totals {
  clips: number;
  ok: number;
  childStates: GroupTotals;
  adultResponses: GroupTotals;
  allTags: GroupTotals;
  peopleMatched: number;
  peopleLabelled: number;
  text: TextStats;
  retried: number;
  msTotal: number;
}

function group(results: readonly ClipResult[], pick: (r: ClipResult) => TagComparison[]): GroupTotals {
  let matched = 0;
  let missed = 0;
  let extra = 0;
  for (const result of results) {
    for (const comparison of pick(result)) {
      matched += comparison.matched.length;
      missed += comparison.missed.length;
      extra += comparison.extra.length;
    }
  }
  return {
    matched,
    missed,
    extra,
    precision: matched + extra === 0 ? null : matched / (matched + extra),
    recall: matched + missed === 0 ? null : matched / (matched + missed),
  };
}

/** 모델 출력을 얻은 클립(ok)만 태그 비교에 넣는다. 실패한 클립은 outcome 으로 따로 센다. */
export function summarise(results: readonly ClipResult[]): Totals {
  const ok = results.filter((r) => r.outcome === 'ok');
  const labelled = ok.filter((r) => r.peopleExpected !== null);
  const text = { ...EMPTY_TEXT };
  for (const result of results) {
    text.written += result.text.written;
    text.wordingRejected += result.text.wordingRejected;
    text.dropped += result.text.dropped;
    text.invalidTags += result.text.invalidTags;
  }
  return {
    clips: results.length,
    ok: ok.length,
    childStates: group(ok, (r) => [r.childStates]),
    adultResponses: group(ok, (r) => [r.adultResponses]),
    allTags: group(ok, (r) => [r.childStates, r.adultResponses]),
    peopleMatched: labelled.filter((r) => r.peopleGot === r.peopleExpected).length,
    peopleLabelled: labelled.length,
    text,
    retried: results.filter((r) => r.attempts > 1).length,
    msTotal: results.reduce((sum, r) => sum + r.ms, 0),
  };
}

function csvCell(value: string | number | null): string {
  if (value === null) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const CSV_HEADER = [
  'clip', 'outcome', 'attempts', 'ms', 'model',
  'child_matched', 'child_missed', 'child_extra', 'adult_matched', 'adult_missed', 'adult_extra',
  'missed_tags', 'extra_tags', 'people_expected', 'people_got',
  'texts_written', 'texts_wording_rejected', 'texts_dropped', 'invalid_tags',
] as const;

/** 클립별 한 줄. 관찰 문장과 사진은 넣지 않는다(태그 이름과 숫자만). */
export function toCsv(results: readonly ClipResult[]): string {
  const rows = results.map((r) =>
    [
      r.id, r.outcome, r.attempts, r.ms, r.model,
      r.childStates.matched.length, r.childStates.missed.length, r.childStates.extra.length,
      r.adultResponses.matched.length, r.adultResponses.missed.length, r.adultResponses.extra.length,
      [...r.childStates.missed, ...r.adultResponses.missed].join(' '),
      [...r.childStates.extra, ...r.adultResponses.extra].join(' '),
      r.peopleExpected, r.peopleGot,
      r.text.written, r.text.wordingRejected, r.text.dropped, r.text.invalidTags,
    ]
      .map(csvCell)
      .join(','),
  );
  return `${[CSV_HEADER.join(','), ...rows].join('\n')}\n`;
}
