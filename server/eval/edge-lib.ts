// 엣지 케이스·품질 시험(server/eval/edge.ts)의 계산 부분. 파일·네트워크 없음.
// 모델이 쓴 글이 왜 기록에서 빠졌는지(문장 검사 갈래, 해요체 아님, 한국어 아님 …)를 가르고 숫자로 모은다.
// 결과에는 갈래 이름과 개수만 남긴다. 모델이 쓴 문장은 메모리에서만 보고 버린다.
import { normaliseObservation, parseModelJson } from '../src/observation.ts';
import type { Observation } from '../src/observation.ts';
import {
  ADVICE_PATTERNS,
  EVALUATIVE_TERMS,
  FORBIDDEN_PATTERNS,
  GUESS_PATTERNS,
  INNER_STATE_PATTERNS,
  JUDGING_PATTERNS,
  LABELING_PATTERNS,
  PERSONAL_PATTERNS,
  PERSON_PATTERNS,
  READING_PATTERNS,
  normaliseForCheck,
} from '../src/wording.ts';

/** 받침 번호(0 = 없음, 4 = ㄴ, 8 = ㄹ). 한글 음절이 아니면 -1. */
function finalConsonant(ch: string): number {
  const code = ch.charCodeAt(0);
  return code >= 0xac00 && code <= 0xd7a3 ? (code - 0xac00) % 28 : -1;
}

// wording.ts 의 내보내지 않은 두 검사와 같은 식(같은지는 server/test/edge-lib.test.ts 가 예문 파일 전체로 확인한다).
function guessEnding(text: string): boolean {
  for (const m of text.matchAll(/([가-힣])가\s*봐요/g)) if (finalConsonant(m[1]!) === 4) return true;
  return false;
}
function guessNoun(text: string): boolean {
  for (const m of text.matchAll(/([가-힣])\s*듯/g)) {
    const f = finalConsonant(m[1]!);
    if (f === 4 || f === 8) return true;
  }
  return false;
}

const any = (patterns: readonly RegExp[]) => (text: string) => patterns.some((p) => p.test(text));

/** passesWordingCheck 와 같은 순서의 갈래. 이름은 wording.ts 의 목록 이름에서 _PATTERNS 를 뗀 것. */
export const WORDING_GROUPS: ReadonlyArray<readonly [string, (text: string) => boolean]> = [
  ['FORBIDDEN', any(FORBIDDEN_PATTERNS)],
  ['EVALUATIVE', (text) => EVALUATIVE_TERMS.some((term) => text.includes(term))],
  ['ADVICE', any(ADVICE_PATTERNS)],
  ['GUESS', (text) => any(GUESS_PATTERNS)(text) || guessEnding(text)],
  ['PERSONAL', any(PERSONAL_PATTERNS)],
  ['LABELING', any(LABELING_PATTERNS)],
  ['JUDGING', any(JUDGING_PATTERNS)],
  ['INNER_STATE', (text) => any(INNER_STATE_PATTERNS)(text) || guessNoun(text)],
  ['PERSON', any(PERSON_PATTERNS)],
  ['READING', any(READING_PATTERNS)],
];

/** 문장 검사에 걸리는 갈래 전부(검사 순서대로). 비어 있으면 문장 검사를 지나간다. */
export function wordingGroups(raw: string): string[] {
  const text = normaliseForCheck(raw);
  return WORDING_GROUPS.filter(([, test]) => test(text)).map(([name]) => name);
}

/** observation.ts 의 tidy 와 같은 다듬기(검사 전에 하는 것). */
function tidy(text: string): string {
  return normaliseForCheck(text.replace(/[\p{Cs}\uFFFD]/gu, ''))
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksKorean(text: string): boolean {
  return /\p{Script=Hangul}/u.test(text) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?…])\s+|(?<=[^.…][.!?])(?=[^\d\s.!?…~"'”’)\]])/).filter((s) => s.length > 0);
}

function endsInHaeyo(sentence: string): boolean {
  return /요[.!?…~"'”’)\]]*$/.test(sentence.trimEnd());
}

/**
 * 글 하나가 기록에 남는지, 남지 않으면 왜인지(observation.ts 의 acceptText 와 같은 순서).
 * 'kept' | 'too_long' | 'empty' | 'not_korean' | 'wording:<첫 갈래>' | 'not_haeyo'
 */
export function textVerdict(value: string): string {
  if (value.length > 2000) return 'too_long';
  const text = tidy(value);
  if (text.length === 0) return 'empty';
  if (!looksKorean(text)) return 'not_korean';
  const groups = wordingGroups(text);
  if (groups.length > 0) return `wording:${groups[0]}`;
  if (!splitSentences(text).some(endsInHaeyo)) return 'not_haeyo';
  return 'kept';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 모델 출력 한 번을 가른 결과(문장 본문은 담지 않는다). */
export interface OutputAnalysis {
  /** 'ok' | 'not_json' | 'no_people_count' | 'nothing_left' */
  result: string;
  observation: Observation | null;
  /** 모델이 쓴 글(summary + note)마다의 판정. */
  verdicts: string[];
  /** 글마다 걸린 갈래 전부(첫 갈래 말고도). 갈래별로 센다. */
  groupHits: Record<string, number>;
  peopleCount: number | null;
  invalidTags: number;
}

export function analyseOutput(text: string, frameTimes: readonly number[], allowedTags: readonly string[]): OutputAnalysis {
  const raw = parseModelJson(text);
  const observation = normaliseObservation(raw, frameTimes);
  const out: OutputAnalysis = { result: 'ok', observation, verdicts: [], groupHits: {}, peopleCount: null, invalidTags: 0 };
  if (!isPlainObject(raw)) {
    out.result = 'not_json';
    return out;
  }
  const texts: string[] = [];
  if (typeof raw.summary === 'string' && raw.summary.trim() !== '') texts.push(raw.summary);
  if (Array.isArray(raw.moments)) {
    for (const m of raw.moments) if (isPlainObject(m) && typeof m.note === 'string' && m.note.trim() !== '') texts.push(m.note);
  }
  for (const t of texts) {
    out.verdicts.push(textVerdict(t));
    for (const g of wordingGroups(tidy(t))) out.groupHits[g] = (out.groupHits[g] ?? 0) + 1;
  }
  for (const key of ['childStates', 'adultResponses']) {
    const list = raw[key];
    if (Array.isArray(list)) out.invalidTags += list.filter((tag) => typeof tag !== 'string' || !allowedTags.includes(tag)).length;
  }
  if (typeof raw.peopleCount !== 'number' || !Number.isFinite(raw.peopleCount)) {
    out.result = 'no_people_count';
    return out;
  }
  out.peopleCount = raw.peopleCount;
  if (observation === null) out.result = 'nothing_left';
  return out;
}

/** 모델 호출 한 번의 기록(시간·토큰은 Ollama 응답에서). */
export interface AttemptRecord {
  ms: number;
  /** 'ok' | 'not_json' | 'no_people_count' | 'nothing_left' | 'unavailable:<코드>' | 'timeout' */
  result: string;
  doneReason: string | null;
  promptTokens: number | null;
  outputTokens: number | null;
  verdicts: string[];
  groupHits: Record<string, number>;
  summaryKept: boolean;
  peopleCount: number | null;
}

/** 서버와 같은 한 요청(최대 2번 호출)의 기록. outcome 은 ok | bad_output | timeout | unavailable */
export interface RunRecord {
  scene: string;
  outcome: string;
  ms: number;
  attempts: AttemptRecord[];
}

export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (rank - lo);
}

export interface SceneSummary {
  scene: string;
  runs: number;
  ok: number;
  badOutput: number;
  timeout: number;
  unavailable: number;
  /** 두 번째 호출까지 간 요청 수. */
  retried: number;
  /** 두 번째 호출로 살아난 요청 수. */
  rescued: number;
  msMedian: number | null;
  msMax: number | null;
  /** 모델이 쓴 글 수와 기록에서 빠진 글 수(모든 호출). */
  texts: number;
  dropped: number;
  /** 빠진 까닭별 개수(wording:갈래, not_haeyo, not_korean …). */
  dropReasons: Record<string, number>;
  /** 갈래별로 걸린 글 수(한 글이 여러 갈래에 걸리면 모두 센다). */
  groupHits: Record<string, number>;
  /** 호출 결과별 개수(ok, nothing_left, not_json …). */
  attemptResults: Record<string, number>;
  /** Ollama done_reason 별 개수(stop, length). */
  doneReasons: Record<string, number>;
  summaryDropped: number;
  outputTokensMedian: number | null;
  /** 기록이 된 호출(ok)의 사람 수별 개수. 사람이 없는 장면에서 0 이 아니면 사람을 지어낸 것이다. */
  peopleCounts: Record<string, number>;
}

function count(map: Record<string, number>, key: string, n = 1) {
  map[key] = (map[key] ?? 0) + n;
}

export function summariseScene(scene: string, runs: readonly RunRecord[]): SceneSummary {
  const s: SceneSummary = {
    scene, runs: runs.length, ok: 0, badOutput: 0, timeout: 0, unavailable: 0, retried: 0, rescued: 0,
    msMedian: percentile(runs.map((r) => r.ms), 0.5), msMax: runs.length ? Math.max(...runs.map((r) => r.ms)) : null,
    texts: 0, dropped: 0, dropReasons: {}, groupHits: {}, attemptResults: {}, doneReasons: {}, summaryDropped: 0,
    outputTokensMedian: null, peopleCounts: {},
  };
  const outTokens: number[] = [];
  for (const run of runs) {
    if (run.outcome === 'ok') s.ok++;
    else if (run.outcome === 'bad_output') s.badOutput++;
    else if (run.outcome === 'timeout') s.timeout++;
    else s.unavailable++;
    if (run.attempts.length > 1) {
      s.retried++;
      if (run.outcome === 'ok') s.rescued++;
    }
    for (const a of run.attempts) {
      count(s.attemptResults, a.result);
      if (a.doneReason) count(s.doneReasons, a.doneReason);
      if (a.outputTokens !== null) outTokens.push(a.outputTokens);
      s.texts += a.verdicts.length;
      for (const v of a.verdicts) {
        if (v !== 'kept') {
          s.dropped++;
          count(s.dropReasons, v);
        }
      }
      for (const [g, n] of Object.entries(a.groupHits)) count(s.groupHits, g, n);
      if (a.result === 'ok' && !a.summaryKept) s.summaryDropped++;
      if (a.result === 'ok') count(s.peopleCounts, String(a.peopleCount));
    }
  }
  s.outputTokensMedian = percentile(outTokens, 0.5);
  return s;
}

const fmtMap = (m: Record<string, number>) =>
  Object.entries(m)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');

export const SCENE_CSV_HEADER = [
  'scene', 'runs', 'ok', 'bad_output', 'timeout', 'unavailable', 'retried', 'rescued', 'ms_median', 'ms_max',
  'texts', 'dropped', 'drop_reasons', 'group_hits', 'attempt_results', 'done_reasons', 'summary_dropped', 'output_tokens_median',
  'people_counts',
] as const;

/** 장면별 한 줄. 문장·사진 없음(갈래 이름과 숫자만). */
export function sceneCsvRow(s: SceneSummary): string {
  const cells = [
    s.scene, s.runs, s.ok, s.badOutput, s.timeout, s.unavailable, s.retried, s.rescued,
    s.msMedian === null ? '' : Math.round(s.msMedian), s.msMax ?? '',
    s.texts, s.dropped, fmtMap(s.dropReasons), fmtMap(s.groupHits), fmtMap(s.attemptResults), fmtMap(s.doneReasons),
    s.summaryDropped, s.outputTokensMedian ?? '', fmtMap(s.peopleCounts),
  ];
  return cells.map((c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : String(c))).join(',');
}

export function sceneLine(s: SceneSummary): string {
  const sec = (ms: number | null) => (ms === null ? '–' : `${(ms / 1000).toFixed(1)}s`);
  return [
    s.scene.padEnd(22),
    `ok ${s.ok}/${s.runs}`.padEnd(9),
    `bad ${s.badOutput}`.padEnd(6),
    `retry ${s.retried}(+${s.rescued})`.padEnd(11),
    `${sec(s.msMedian)}/${sec(s.msMax)}`.padEnd(13),
    `drop ${s.dropped}/${s.texts}`.padEnd(11),
    `people ${fmtMap(s.peopleCounts) || '-'}`.padEnd(14),
    fmtMap(s.dropReasons) || '-',
  ].join(' ');
}
