import { createHash } from 'node:crypto';
import { classroomActivities } from './daycareActivities.ts';
import { HttpError } from './httpError.ts';
import { toVisionOutput } from './provider.ts';
import type { VisionProvider } from './provider.ts';
import type { WorkQueue } from './queue.ts';

interface CoachingRequest { childId: number; month: string }
interface Card { code: string; title: string; body: string }
interface Recommendation { sourceCode: string; sourceTitle: string; title: string; action: string }

const unavailable = () => new HttpError(503, 'COACHING_UNAVAILABLE', '어린이집 추천을 불러오지 못했어요. 잠시 뒤에 다시 시도해 주세요.');
const busy = () => new HttpError(429, 'BUSY', '지금 다른 요청을 살펴보고 있어요. 잠시 뒤에 다시 시도해 주세요.', undefined, { 'Retry-After': '5' });

export function parseCoachingRequest(raw: Buffer): CoachingRequest {
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (value && Object.keys(value).length === 2 && Number.isSafeInteger(value.childId) && value.childId > 0 &&
        typeof value.month === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value.month)) {
      return { childId: value.childId, month: value.month };
    }
  } catch { /* Invalid JSON follows the same response as an invalid shape. */ }
  throw new HttpError(400, 'INVALID_REQUEST', '아이와 조회할 달을 확인해 주세요.');
}

function cardList(value: unknown): Card[] {
  if (!Array.isArray(value) || value.length > 8) throw unavailable();
  return value.map((card) => {
    if (!card || typeof card.code !== 'string' || !/^[A-Z0-9-]{1,40}$/.test(card.code) ||
        typeof card.title !== 'string' || !card.title.trim() || card.title.length > 255 ||
        typeof card.body !== 'string' || !card.body.trim() || card.body.length > 4000) throw unavailable();
    return { code: card.code, title: card.title, body: card.body };
  });
}

function signature(cards: Card[]): string {
  return createHash('sha256').update(JSON.stringify(cards)).digest('hex');
}

async function chooseActivity(cards: Card[], provider: VisionProvider, queue: WorkQueue): Promise<Recommendation | null> {
  const candidates = cards.flatMap(card => classroomActivities.filter(activity => activity.codes.includes(card.code))
    .map(({ title, action }) => ({ sourceCode: card.code, sourceTitle: card.title, title, action })));
  if (!candidates.length) return null;
  // Leave the model queue available to observation requests while it is busy.
  if (queue.active || queue.waiting) throw busy();
  const signal = AbortSignal.timeout(30_000);
  const release = await queue.acquire(signal);
  try {
    const choices = candidates.map(({ sourceCode, title, action }, index) => ({ index, sourceCode, title, action }));
    const output = await provider.generate({
      system: '어린이집 교사의 하루를 돕는 코칭 도우미입니다. 공유된 가정 코칭을 읽고 제시된 활동 중 하나를 고르세요. 여러 카드에 공통인 방법과 다음 자유놀이나 일과에 바로 시도할 수 있는 구체적인 행동을 우선하세요. 카드 내용만으로 아이가 울었거나 특정 행동을 했다고 단정하지 마세요. 선택한 활동의 index를 JSON으로 답하세요.',
      user: JSON.stringify({ cards, choices }),
      images: [],
      schema: {
        type: 'object', additionalProperties: false, required: ['index'],
        properties: { index: { type: 'integer', enum: choices.map(choice => choice.index) } },
      },
      signal,
    });
    const result = JSON.parse(toVisionOutput(output, provider.modelVersion).text);
    if (!result || !Number.isInteger(result.index) || !candidates[result.index]) throw unavailable();
    return candidates[result.index]!;
  } catch {
    throw unavailable();
  } finally {
    release();
  }
}

export function createDaycareCoaching(origin: string | null | undefined, provider: VisionProvider, queue: WorkQueue, fetchApi = fetch) {
  // Keys cover the complete ordered input. Values contain only catalog content.
  // No child IDs, credentials, observation records, or images are cached.
  const cache = new Map<string, Recommendation>();
  const pending = new Map<string, Promise<Recommendation | null>>();
  let active = 0;

  async function loadCards(token: string, input: CoachingRequest, client?: AbortSignal): Promise<Card[]> {
    if (!origin) throw unavailable();
    const deadline = AbortSignal.timeout(8_000);
    const url = new URL(`/api/v1/teacher/children/${input.childId}/daycare-coaching/cards`, origin);
    url.searchParams.set('month', input.month);
    try {
      const res = await fetchApi(url, {
        headers: { Authorization: `Bearer ${token}` }, redirect: 'error', cache: 'no-store',
        signal: client ? AbortSignal.any([client, deadline]) : deadline,
      });
      if (!res.ok) {
        await res.body?.cancel();
        if (res.status === 401) throw new HttpError(401, 'UNAUTHORIZED', '다시 로그인해 주세요.');
        if (res.status === 403 || res.status === 404) throw new HttpError(res.status, 'COACHING_NOT_SHARED', '공유된 코칭을 볼 수 없어요.');
        if (res.status === 429) throw busy();
        throw unavailable();
      }
      return cardList(await res.json());
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw unavailable();
    }
  }

  function selection(cards: Card[], key: string): Promise<Recommendation | null> {
    const cached = cache.get(key);
    if (cached) return Promise.resolve(cached);
    const running = pending.get(key);
    if (running) return running;
    const operation = chooseActivity(cards, provider, queue).then(result => {
      if (result) {
        if (cache.size >= 128) cache.delete(cache.keys().next().value!);
        cache.set(key, result);
      }
      return result;
    }).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  }

  return async (token: string, input: CoachingRequest, client?: AbortSignal): Promise<Recommendation | null> => {
    if (active >= 12) throw busy();
    active++;
    try {
      const cards = await loadCards(token, input, client);
      if (!cards.length) return null;
      const key = signature(cards);
      const result = await selection(cards, key);
      if (!result) return null;
      const current = await loadCards(token, input, client);
      if (signature(current) !== key) throw new HttpError(409, 'COACHING_CHANGED', '공유된 코칭이 바뀌었어요. 다시 불러와 주세요.');
      return result;
    } finally {
      active--;
    }
  };
}
