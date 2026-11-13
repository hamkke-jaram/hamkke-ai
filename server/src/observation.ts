// 관찰 기록 객체(명세 6장): 태그 목록, 모델 출력 해석, 검사와 다듬기.
// 모델이 쓴 글은 믿지 않는다. 목록에 없는 태그와 문장 검사에 걸린 글은 버리고, 길이를 맞춘다.
import { passesWordingCheck } from './wording.ts';

export const CHILD_STATES = [
  'PLAYING_TOGETHER',
  'PLAYING_ALONE',
  'FOCUSED',
  'MOVING_AROUND',
  'SEEKING_ADULT',
  'UPSET_CRYING',
  'REFUSING',
  'THROWING_OR_HITTING',
  'CALM',
] as const;

export const ADULT_RESPONSES = [
  'JOINING_PLAY',
  'TALKING',
  'WAITING',
  'COMFORTING',
  'REDIRECTING',
  'SETTING_LIMIT',
] as const;

export type ChildState = (typeof CHILD_STATES)[number];
export type AdultResponse = (typeof ADULT_RESPONSES)[number];

/** 화면 표시 문구(명세 6장 표). 프롬프트에서 태그의 뜻을 알려 줄 때 쓴다. */
export const CHILD_STATE_LABELS: Record<ChildState, string> = {
  PLAYING_TOGETHER: '어른과 함께 놀아요',
  PLAYING_ALONE: '혼자 놀아요',
  FOCUSED: '한 가지에 푹 빠져 있어요',
  MOVING_AROUND: '자리를 자주 옮겨요',
  SEEKING_ADULT: '어른에게 다가가요',
  UPSET_CRYING: '울거나 속상해해요',
  REFUSING: '싫다고 표현해요',
  THROWING_OR_HITTING: '물건을 던지거나 쳐요',
  CALM: '차분해요',
};

export const ADULT_RESPONSE_LABELS: Record<AdultResponse, string> = {
  JOINING_PLAY: '놀이에 함께해요',
  TALKING: '말을 걸어 줘요',
  WAITING: '기다려 줘요',
  COMFORTING: '안아 주거나 달래 줘요',
  REDIRECTING: '다른 놀이로 이끌어요',
  SETTING_LIMIT: '안 되는 것을 알려 줘요',
};

export const MAX_TAGS = 3;
export const MAX_MOMENTS = 4;
export const MAX_SUMMARY_LENGTH = 300;
export const MAX_SUMMARY_SENTENCES = 3;
export const MAX_NOTE_LENGTH = 120;
export const MAX_PEOPLE_COUNT = 3;

/** 모델이 moments 를 지나치게 많이 내도 이만큼만 들여다본다. */
const MAX_MOMENTS_EXAMINED = 12;
/** 다듬기 전에 받아들이는 글 길이. 이보다 길면 통째로 버린다. */
const MAX_RAW_TEXT_LENGTH = 2000;

export interface Moment {
  t: number;
  note: string;
}

export interface Observation {
  summary: string | null;
  childStates: ChildState[];
  adultResponses: AdultResponse[];
  moments: Moment[];
  peopleCount: number;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 모델이 쓴 글에서 JSON 객체를 꺼낸다. 앞뒤에 다른 글이 붙어 있으면 가장 바깥 중괄호만 본다. */
export function parseModelJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/**
 * 제어 문자와 줄바꿈을 없애고 공백을 하나로 줄인다.
 * 짝이 맞지 않는 대리 문자(모델 출력의 반쪽 이스케이프)와 깨진 글자 표시(U+FFFD)는 지운다:
 * 남겨 두면 hamkke-api 가 영수증을 통째로 받지 않는다.
 */
function tidy(text: string): string {
  return text
    .replace(/[\p{Cs}�]/gu, '')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 한글이 들어 있고 한자·가나가 섞이지 않았는지. */
function looksKorean(text: string): boolean {
  return /\p{Script=Hangul}/u.test(text) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text);
}

function cutAt(text: string, maxLength: number): string {
  let cut = text.slice(0, maxLength - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // 반쪽 글자를 남기지 않는다
  return `${cut.trimEnd()}…`;
}

/**
 * 문장으로 나눈다. 문장 부호 뒤에 공백이 있으면 나누고, 공백 없이 붙여 쓴 글('논다.어른이')도 나눈다.
 * 붙여 쓴 경우에는 소수점(1.5), 이어지는 문장 부호(...), 닫는 따옴표·괄호 앞에서는 나누지 않는다.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|(?<=[^.…][.!?])(?=[^\d\s.!?…~"'”’)\]])/)
    .filter((s) => s.length > 0);
}

/** 해요체로 끝나는 문장인지: 끝의 문장 부호를 떼면 마지막 글자가 '요'. */
export function endsInHaeyo(sentence: string): boolean {
  return /요[.!?…~"'”’)\]]*$/.test(sentence.trimEnd());
}

/** 문장 수와 글자 수를 맞춘다. 되도록 문장 단위로 줄이고, 한 문장이 너무 길 때만 자른다. */
export function limitText(text: string, maxSentences: number, maxLength: number): string {
  let sentences = splitSentences(text);
  if (sentences.length > maxSentences) sentences = sentences.slice(0, maxSentences);
  while (sentences.length > 1 && sentences.join(' ').length > maxLength) sentences.pop();
  const joined = sentences.join(' ');
  return joined.length > maxLength ? cutAt(joined, maxLength) : joined;
}

/**
 * 글 하나를 다듬고 검사한다. 쓸 수 없으면 null.
 * 문장 검사에 걸리면 글 전체를 버리고(명세 6장), 해요체가 아닌 문장은 그 문장만 뺀다.
 */
function acceptText(value: unknown, maxSentences: number, maxLength: number): string | null {
  if (typeof value !== 'string' || value.length > MAX_RAW_TEXT_LENGTH) return null;
  const text = tidy(value);
  if (text.length === 0 || !looksKorean(text) || !passesWordingCheck(text)) return null;
  const polite = splitSentences(text).filter(endsInHaeyo);
  if (polite.length === 0) return null;
  return limitText(polite.join(' '), maxSentences, maxLength);
}

function pickTags<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) return [];
  const picked: T[] = [];
  for (const item of value) {
    const tag = allowed.find((a) => a === item);
    if (tag !== undefined && !picked.includes(tag)) picked.push(tag);
    if (picked.length === MAX_TAGS) break;
  }
  return picked;
}

/** 보낸 사진 시각 가운데 가장 가까운 값. */
export function snapToFrameTime(t: number, frameTimes: readonly number[]): number {
  let best = frameTimes[0] ?? 0;
  for (const candidate of frameTimes) {
    if (Math.abs(candidate - t) < Math.abs(best - t)) best = candidate;
  }
  return best;
}

function pickMoments(value: unknown, frameTimes: readonly number[]): Moment[] {
  if (!Array.isArray(value) || frameTimes.length === 0) return [];
  const moments: Moment[] = [];
  for (const item of value.slice(0, MAX_MOMENTS_EXAMINED)) {
    if (!isPlainObject(item) || typeof item.t !== 'number' || !Number.isFinite(item.t)) continue;
    const note = acceptText(item.note, Number.POSITIVE_INFINITY, MAX_NOTE_LENGTH);
    if (note === null) continue;
    const t = snapToFrameTime(item.t, frameTimes);
    if (moments.some((m) => m.note === note)) continue; // 같은 말을 되풀이한 항목
    moments.push({ t, note });
    if (moments.length === MAX_MOMENTS) break;
  }
  return moments.sort((a, b) => a.t - b.t);
}

/**
 * 모델 출력을 명세 6장의 객체로 다듬는다.
 * 객체가 아니거나 사람 수가 없거나, 검사 뒤에 남은 것이 하나도 없으면 null(다시 시도할 일).
 */
export function normaliseObservation(raw: unknown, frameTimes: readonly number[]): Observation | null {
  if (!isPlainObject(raw)) return null;
  if (typeof raw.peopleCount !== 'number' || !Number.isFinite(raw.peopleCount)) return null;
  const peopleCount = Math.min(MAX_PEOPLE_COUNT, Math.max(0, Math.round(raw.peopleCount)));

  // 사람이 한 명도 보이지 않는 장면에는 아이 모습·어른 반응·순간 메모가 있을 수 없다.
  const nobody = peopleCount === 0;
  const observation: Observation = {
    summary: acceptText(raw.summary, MAX_SUMMARY_SENTENCES, MAX_SUMMARY_LENGTH),
    childStates: nobody ? [] : pickTags(raw.childStates, CHILD_STATES),
    adultResponses: nobody ? [] : pickTags(raw.adultResponses, ADULT_RESPONSES),
    moments: nobody ? [] : pickMoments(raw.moments, frameTimes),
    peopleCount,
  };
  const nothingLeft =
    observation.summary === null &&
    observation.childStates.length === 0 &&
    observation.adultResponses.length === 0 &&
    observation.moments.length === 0;
  return nothingLeft ? null : observation;
}
