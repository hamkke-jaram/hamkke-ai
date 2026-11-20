import { HttpError } from './httpError.ts';
import { signJwt, RECEIPT_TTL_SEC } from './jwt.ts';
import { CORPUS_VERSION, findEvidence, groundRecommendations, type Recommendation } from './observationEvidence.ts';
import type { VisionProvider } from './provider.ts';
import type { WorkQueue } from './queue.ts';

interface Input { childId: number; observationId: number; summary?: string }
interface Context {
  reviewerId: number; ageMonths: number | null; summary: string; notes: string[]; peopleCount: number;
}
const unavailable = () => new HttpError(503, 'GUIDANCE_UNAVAILABLE', '근거 자료를 대조하지 못했어요. 잠시 뒤 다시 시도해 주세요.');
const changed = () => new HttpError(409, 'REVIEW_CHANGED', '검토 상태가 바뀌었어요. 다시 불러와 주세요.');
const busy = () => new HttpError(429, 'BUSY', 'AI가 다른 요청을 처리하고 있어요. 잠시 뒤 다시 시도해 주세요.', undefined, { 'Retry-After': '5' });
const isId = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function parseGuidanceInput(raw: Buffer): Input {
  try {
    const data = JSON.parse(raw.toString('utf8'));
    if (data && Object.keys(data).every(k => ['childId', 'observationId', 'summary'].includes(k)) &&
      isId(data.childId) && isId(data.observationId) &&
      (data.summary === undefined || (typeof data.summary === 'string' && data.summary.trim() && data.summary.length <= 500))) {
      return { childId:data.childId, observationId:data.observationId, summary:data.summary?.trim() };
    }
  } catch { /* Invalid JSON and invalid fields have the same response. */ }
  throw new HttpError(400, 'INVALID_REQUEST', '검토할 기록과 관찰 문장을 확인해 주세요.');
}

export function createObservationGuidance(origin: string | null | undefined, secret: Buffer, model: VisionProvider | null,
  queue: WorkQueue, now: () => number, fetchApi = fetch) {
  let active = 0;
  async function context(input: Input, token: string, signal: AbortSignal): Promise<Context> {
    if (!origin) throw unavailable();
    const url = new URL(`/api/v1/children/${input.childId}/ai-observations/${input.observationId}/review`, origin);
    const response = await fetchApi(url, { headers:{ Authorization:`Bearer ${token}` }, redirect:'error', cache:'no-store',
      signal:AbortSignal.any([signal, AbortSignal.timeout(7000)]) });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401) throw new HttpError(401, 'UNAUTHORIZED', '다시 로그인해 주세요.');
      if ([403,404].includes(response.status)) throw new HttpError(response.status, 'REVIEW_UNAVAILABLE', '검토할 수 있는 관찰 기록을 찾지 못했어요.');
      if (response.status === 409) throw changed();
      if (response.status === 429) throw busy();
      throw unavailable();
    }
    const data = await response.json();
    if (!isRecord(data)) throw unavailable();
    if (data.status === 'PUBLISHED') throw changed();
    const o = data.observation;
    if (data.status !== 'PENDING' || !isId(data.reviewerId) || !isRecord(o) || o.id !== input.observationId || o.source !== 'HOME' ||
        typeof o.peopleCount !== 'number' || !Number.isInteger(o.peopleCount) || o.peopleCount < 0 || o.peopleCount > 100 ||
        (o.summary !== null && (typeof o.summary !== 'string' || o.summary.length > 500)) ||
        !Array.isArray(o.moments) || o.moments.length > 12 ||
        o.moments.some((m: {note?: unknown} | null) => !m || typeof m.note !== 'string' || m.note.length > 500)) throw unavailable();
    return { reviewerId:data.reviewerId, ageMonths:typeof data.ageMonths === 'number' && Number.isInteger(data.ageMonths) && data.ageMonths >= 0 ? data.ageMonths : null,
      summary:o.summary?.trim() || '', notes:o.moments.map((m: {note: string}) => m.note.trim()), peopleCount:o.peopleCount };
  }
  return async (input: Input, token: string, client?: AbortSignal) => {
    if (active >= 12) throw busy();
    active++;
    try {
      const deadline = AbortSignal.timeout(45_000);
      const signal = client ? AbortSignal.any([client,deadline]) : deadline;
      const review = await context(input, token, signal);
      const summary = input.summary ?? (review.summary || review.notes.find(n => n.length > 0) || '장면만으로는 행동을 확인하기 어려워요.');
      // An edit supersedes all original moments. Never retrieve on a fact the teacher removed.
      const cues = input.summary === undefined ? [review.summary, ...review.notes] : [input.summary];
      const candidates = review.peopleCount ? findEvidence(cues, review.ageMonths) : [];
      let recommendations: Recommendation[] = [];
      if (candidates.length) {
        if (!model) throw unavailable();
        if (queue.active || queue.waiting) throw busy();
        const release = await queue.acquire(signal);
        try { recommendations = await groundRecommendations(model, candidates, signal); }
        finally { release(); }
      }
      const latest = await context(input, token, signal);
      if (JSON.stringify(latest) !== JSON.stringify(review)) throw changed();
      const iat = Math.floor(now()/1000);
      const result = { summary, recommendations, corpusVersion:CORPUS_VERSION };
      return { ...result, receipt:signJwt({ iss:'hamkke-ai', aud:'hamkke-api-guidance', typ:'ai-guidance', sub:String(review.reviewerId),
        cid:input.childId, oid:input.observationId, iat, exp:iat + RECEIPT_TTL_SEC, ...result }, secret) };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw unavailable();
    } finally { active--; }
  };
}
