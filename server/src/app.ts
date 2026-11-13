// 요청 처리기 (hamkke-api docs/ai-observation.md 5장).
// 소켓을 열지 않고도 테스트할 수 있게, 요청·응답을 단순한 값으로 주고받는다(index.ts 가 node:http 와 잇는다).
//
// 지키는 것
// - 사진은 메모리에서만 다루고, 모델 호출이 끝나면 참조를 버린다.
// - 로그에는 요청 id, jti 해시 앞부분, 장수, 바이트, 걸린 시간, 결과 코드만 남긴다.
// - CORS 헤더를 내지 않는다(웹은 같은 출처의 /ai/ 프록시로 부른다).
import { createHash, randomUUID } from 'node:crypto';
import { BodyTooLargeError, FrameError, MAX_BODY_BYTES, parseAnalyzeBody, readBody } from './frames.ts';
import type { AnalyzeInput } from './frames.ts';
import { createJtiStore } from './jtiStore.ts';
import type { JtiStore } from './jtiStore.ts';
import { TokenError, signReceipt, verifySessionToken } from './jwt.ts';
import type { SessionClaims } from './jwt.ts';
import { normaliseObservation, parseModelJson } from './observation.ts';
import type { Observation } from './observation.ts';
import { PROMPT_VERSION, buildPrompt } from './prompt.ts';
import { ProviderTimeoutError, ProviderUnavailableError } from './provider.ts';
import type { VisionProvider } from './provider.ts';
import { QueueFullError, createQueue } from './queue.ts';
import type { WorkQueue } from './queue.ts';

export const ANALYZE_PATH = '/ai/v1/analyze';
export const HEALTH_PATH = '/ai/v1/health';

const MODEL_ATTEMPTS = 2;
const HEALTH_CACHE_MS = 5_000;
const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const BUSY_RETRY_AFTER_SEC = '10';
/** 응답을 보내지 못한 요청(요청한 쪽이 먼저 끊음)을 로그에 적을 때 쓰는 상태 값. */
const CLIENT_CLOSED_STATUS = 499;

export interface AppRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** 요청한 쪽이 연결을 끊으면 중단되는 신호. */
  signal?: AbortSignal;
}

export interface AppResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** 요청 하나에 남기는 로그 한 줄. 사진·문장·토큰은 담지 않는다. */
export interface LogEntry {
  ts: string;
  rid: string;
  route: 'analyze' | 'health' | 'other';
  /** jti 의 SHA-256 앞 12자. */
  jti: string | null;
  frames: number;
  bytes: number;
  ms: number;
  status: number;
  code: string;
  /** 모델을 부른 횟수. */
  attempts?: number;
  /** 실패한 까닭을 가리키는 짧은 코드. */
  detail?: string;
}

export interface AppConfig {
  secret: Buffer;
  /** 요청 하나의 제한 시간: 차례를 기다린 시간과 모델 호출(다시 시도 포함)을 합쳐서 잰다. */
  timeoutMs: number;
  maxConcurrency: number;
  maxWaiting: number;
  /** 차례를 기다리는 시간의 상한. 정하지 않으면 timeoutMs 의 절반(모델 호출에 적어도 절반이 남는다). */
  maxWaitMs?: number;
}

export interface AppDeps {
  config: AppConfig;
  provider: VisionProvider;
  /** 지금 시각(밀리초). 테스트에서 바꿔 끼운다. */
  now?: () => number;
  log?: (entry: LogEntry) => void;
  jtiStore?: JtiStore;
  queue?: WorkQueue;
}

export interface App {
  handle(request: AppRequest): Promise<AppResponse>;
}

class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: string | undefined;
  readonly headers: Record<string, string>;

  constructor(status: number, code: string, message: string, detail?: string, headers: Record<string, string> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.headers = headers;
  }
}

class ClientClosedError extends Error {
  constructor() {
    super('client closed the connection');
    this.name = 'ClientClosedError';
  }
}

const errors = {
  invalidFrames: (detail: string) =>
    new HttpError(400, 'INVALID_FRAMES', '보낸 장면 사진을 읽을 수 없어요. 다시 찍어서 보내 주세요.', detail),
  invalidToken: (detail: string) =>
    new HttpError(401, 'INVALID_TOKEN', '준비 시간이 지났거나 확인할 수 없는 요청이에요. 처음부터 다시 해 주세요.', detail),
  notFound: () => new HttpError(404, 'NOT_FOUND', '찾을 수 없는 주소예요.'),
  methodNotAllowed: (allow: string) =>
    new HttpError(405, 'METHOD_NOT_ALLOWED', '이 주소에서는 쓸 수 없는 요청 방식이에요.', undefined, { Allow: allow }),
  alreadyUsed: () =>
    new HttpError(409, 'SESSION_ALREADY_USED', '이미 한 번 쓴 요청이에요. 처음부터 다시 해 주세요.'),
  tooLarge: (detail: string) =>
    new HttpError(413, 'PAYLOAD_TOO_LARGE', '보낸 내용이 너무 커요. 사진 수나 크기를 줄여 주세요.', detail),
  unsupportedMediaType: () =>
    new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON 형식(application/json)으로 보내 주세요.'),
  busy: (detail: string) =>
    new HttpError(429, 'BUSY', '지금 다른 기록을 살펴보고 있어요. 잠시 뒤에 다시 해 주세요.', detail, {
      'Retry-After': BUSY_RETRY_AFTER_SEC,
    }),
  modelUnavailable: (detail: string) =>
    new HttpError(502, 'MODEL_UNAVAILABLE', '지금은 관찰 기록을 만들지 못했어요. 잠시 뒤에 다시 해 주세요.', detail),
  modelTimeout: () =>
    new HttpError(504, 'MODEL_TIMEOUT', '관찰 기록을 만드는 데 시간이 오래 걸려서 멈췄어요. 잠시 뒤에 다시 해 주세요.'),
};

function json(status: number, payload: unknown, extra: Record<string, string> = {}): AppResponse {
  return {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
    body: JSON.stringify(payload),
  };
}

function header(request: AppRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function pathOf(url: string): string {
  const end = url.search(/[?#]/);
  return end === -1 ? url : url.slice(0, end);
}

function bearerToken(request: AppRequest): string {
  const value = header(request, 'authorization');
  const match = value === undefined ? null : /^Bearer +([A-Za-z0-9._-]+)$/i.exec(value.trim());
  if (!match) throw errors.invalidToken('missing');
  return match[1]!;
}

function isJsonContent(request: AppRequest): boolean {
  const value = header(request, 'content-type');
  return value !== undefined && value.split(';')[0]!.trim().toLowerCase() === 'application/json';
}

function declaredLength(request: AppRequest): number | null {
  const value = header(request, 'content-length');
  if (value === undefined || !/^\d+$/.test(value.trim())) return null;
  return Number(value.trim());
}

function hashPrefix(jti: string): string {
  return createHash('sha256').update(jti, 'utf8').digest('hex').slice(0, 12);
}

/** 신호가 중단되면 기다리던 약속을 놓는다(신호를 따르지 않는 제공자에 대비). */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new DOMException('aborted', 'AbortError'));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new DOMException('aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

function defaultLog(entry: LogEntry): void {
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}

export function createApp(deps: AppDeps): App {
  const { config, provider } = deps;
  const now = deps.now ?? Date.now;
  const log = deps.log ?? defaultLog;
  const jtiStore = deps.jtiStore ?? createJtiStore();
  const queue = deps.queue ?? createQueue(config.maxConcurrency, config.maxWaiting);
  const maxWaitMs = Math.min(config.maxWaitMs ?? Math.floor(config.timeoutMs / 2), config.timeoutMs);

  let readiness: { at: number; ready: boolean } | null = null;
  let readinessCheck: Promise<boolean> | null = null;

  /** 모델을 쓸 수 있는지. 확인 결과를 몇 초 동안 기억해 건강 확인이 모델 서버를 두드리지 않게 한다. */
  function modelReady(): Promise<boolean> {
    if (readiness !== null && now() - readiness.at < HEALTH_CACHE_MS) return Promise.resolve(readiness.ready);
    readinessCheck ??= provider
      .isReady(AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS))
      .then(
        (ready) => ready === true,
        () => false,
      )
      .then((ready) => {
        readiness = { at: now(), ready };
        readinessCheck = null;
        return ready;
      });
    return readinessCheck;
  }

  async function health(): Promise<AppResponse> {
    return json(200, { status: 'ok', model: provider.modelVersion, modelReady: await modelReady() });
  }

  function authenticate(request: AppRequest): SessionClaims {
    try {
      return verifySessionToken(bearerToken(request), config.secret, Math.floor(now() / 1000));
    } catch (err) {
      if (err instanceof TokenError) throw errors.invalidToken(err.reason);
      throw err;
    }
  }

  async function readInput(request: AppRequest, entry: LogEntry): Promise<AnalyzeInput> {
    const declared = declaredLength(request);
    if (declared !== null && declared > MAX_BODY_BYTES) throw errors.tooLarge('content_length');
    let raw: Buffer;
    try {
      raw = await readBody(request.body, MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) throw errors.tooLarge('body');
      throw new ClientClosedError(); // 읽는 도중 연결이 끊김
    }
    entry.bytes = raw.length;
    try {
      const input = parseAnalyzeBody(raw);
      entry.frames = input.frames.length;
      return input;
    } catch (err) {
      if (err instanceof FrameError) throw errors.invalidFrames(err.reason);
      throw err;
    }
  }

  /** 모델을 불러 관찰 기록을 만든다. 쓸 수 없는 출력이나 연결 실패는 한 번 더 해 본다. */
  async function describe(
    input: AnalyzeInput,
    signal: AbortSignal,
    deadline: AbortSignal,
    client: AbortSignal | undefined,
    entry: LogEntry,
  ): Promise<Observation> {
    const frameTimes = input.frames.map((frame) => frame.t);
    const prompt = buildPrompt(frameTimes, input.durationSec);
    const images = input.frames.map((frame) => frame.jpeg);
    let detail = 'bad_output';
    try {
      for (let attempt = 1; attempt <= MODEL_ATTEMPTS; attempt++) {
        entry.attempts = attempt;
        let text: string;
        try {
          text = await abortable(provider.generate({ ...prompt, images, signal }), signal);
        } catch (err) {
          if (client?.aborted) throw new ClientClosedError();
          if (deadline.aborted || err instanceof ProviderTimeoutError) throw errors.modelTimeout();
          detail = err instanceof ProviderUnavailableError ? err.detail : 'provider_error';
          continue;
        }
        const observation = normaliseObservation(parseModelJson(text), frameTimes);
        if (observation !== null) return observation;
        detail = 'bad_output';
      }
      throw errors.modelUnavailable(detail);
    } finally {
      images.length = 0;
    }
  }

  async function analyze(request: AppRequest, entry: LogEntry): Promise<AppResponse> {
    const session = authenticate(request);
    entry.jti = hashPrefix(session.jti);
    if (!isJsonContent(request)) throw errors.unsupportedMediaType();
    // 본문을 읽기 전에 토큰을 잡아 둔다. 같은 토큰으로 연결을 여러 개 열어도 본문은 하나만 읽는다.
    if (!jtiStore.add(session.jti, session.exp * 1000, now())) {
      throw jtiStore.has(session.jti, now()) ? errors.alreadyUsed() : errors.busy('jti_store_full');
    }

    // 사진이 모델에 닿기 전에 끝난 요청(400·413·429·연결 끊김)은 토큰을 되돌려 다시 쓸 수 있게 한다.
    let reachedModel = false;
    let input: AnalyzeInput | null = null;
    const deadline = new AbortController();
    const waitLimit = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      input = await readInput(request, entry);
      const frameCount = input.frames.length;
      if (request.signal?.aborted) throw new ClientClosedError();
      const signal = request.signal ? AbortSignal.any([deadline.signal, request.signal]) : deadline.signal;
      timer = setTimeout(() => deadline.abort(), config.timeoutMs);

      // 차례는 maxWaitMs 까지만 기다린다. 더 기다렸다가 자리를 얻으면 남은 시간으로는 모델 호출을
      // 끝낼 수 없어, 자리만 차지하다 504 로 끝나고 토큰도 쓴 것이 되기 때문이다.
      waitTimer = setTimeout(() => waitLimit.abort(), maxWaitMs);
      let release: () => void;
      try {
        release = await queue.acquire(AbortSignal.any([waitLimit.signal, signal]));
      } catch (err) {
        if (err instanceof QueueFullError) throw errors.busy('queue_full');
        if (request.signal?.aborted) throw new ClientClosedError();
        throw errors.busy('wait_timeout');
      } finally {
        clearTimeout(waitTimer);
      }

      reachedModel = true;
      let observation: Observation;
      try {
        observation = await describe(input, signal, deadline.signal, request.signal, entry);
      } finally {
        release();
      }

      const receipt = signReceipt(
        {
          session,
          obs: observation,
          modelVersion: provider.modelVersion,
          promptVersion: PROMPT_VERSION,
          frameCount,
        },
        config.secret,
        Math.floor(now() / 1000),
      );
      return json(200, {
        observation,
        receipt,
        modelVersion: provider.modelVersion,
        promptVersion: PROMPT_VERSION,
        analyzedFrames: frameCount,
      });
    } finally {
      clearTimeout(timer);
      clearTimeout(waitTimer);
      if (!reachedModel) jtiStore.delete(session.jti);
      if (input !== null) {
        // 사진(base64 문자열)을 가리키는 참조를 모두 놓는다.
        for (const frame of input.frames) frame.jpeg = '';
        input.frames.length = 0;
      }
    }
  }

  function route(request: AppRequest, entry: LogEntry): Promise<AppResponse> {
    const path = pathOf(request.url);
    const method = request.method.toUpperCase();
    if (path === ANALYZE_PATH) {
      entry.route = 'analyze';
      if (method !== 'POST') throw errors.methodNotAllowed('POST');
      return analyze(request, entry);
    }
    if (path === HEALTH_PATH) {
      entry.route = 'health';
      if (method !== 'GET') throw errors.methodNotAllowed('GET');
      return health();
    }
    throw errors.notFound();
  }

  async function handle(request: AppRequest): Promise<AppResponse> {
    const started = now();
    const entry: LogEntry = {
      ts: new Date(started).toISOString(),
      rid: randomUUID(),
      route: 'other',
      jti: null,
      frames: 0,
      bytes: 0,
      ms: 0,
      status: 0,
      code: 'OK',
    };
    let response: AppResponse;
    try {
      response = await route(request, entry);
    } catch (err) {
      if (err instanceof HttpError) {
        response = json(err.status, { code: err.code, message: err.message }, err.headers);
        entry.code = err.code;
        if (err.detail !== undefined) entry.detail = err.detail;
      } else if (err instanceof ClientClosedError) {
        response = json(CLIENT_CLOSED_STATUS, { code: 'CLIENT_CLOSED', message: '연결이 끊겼어요.' });
        entry.code = 'CLIENT_CLOSED';
      } else {
        // 오류 문장에는 요청 내용이 섞일 수 있어 종류만 남긴다.
        response = json(500, { code: 'INTERNAL_ERROR', message: '요청을 처리하지 못했어요. 잠시 뒤에 다시 해 주세요.' });
        entry.code = 'INTERNAL_ERROR';
        entry.detail = err instanceof Error ? err.name : 'unknown';
      }
    }
    response.headers['X-Request-Id'] = entry.rid;
    entry.status = response.status;
    entry.ms = now() - started;
    // 문제없이 끝난 건강 확인은 적지 않는다(컨테이너가 수십 초마다 부른다).
    if (entry.route !== 'health' || response.status !== 200) log(entry);
    return response;
  }

  return { handle };
}
