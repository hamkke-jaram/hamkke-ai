// 서버 테스트 공용 도구. 네트워크도 실제 모델도 쓰지 않는다.
import { createApp } from '../src/app.ts';
import type { App, AppDeps, AppRequest, AppResponse, LogEntry } from '../src/app.ts';
import { signJwt } from '../src/jwt.ts';
import type { VisionProvider, VisionRequest } from '../src/provider.ts';

export const SECRET = Buffer.from('test-only-shared-secret-0123456789-abcdefghij', 'utf8');
export const OTHER_SECRET = Buffer.from('another-secret-that-is-not-shared-0123456789', 'utf8');
/** 테스트에서 쓰는 고정 시각(밀리초). */
export const NOW_MS = 1_800_000_000_000;
export const NOW_SEC = NOW_MS / 1000;

let jtiCounter = 0;

export function newJti(): string {
  jtiCounter++;
  return `00000000-0000-4000-8000-${String(jtiCounter).padStart(12, '0')}`;
}

export function sessionPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'hamkke-api',
    aud: 'hamkke-ai',
    sub: '42',
    cid: 7,
    src: 'HOME',
    jti: newJti(),
    iat: NOW_SEC - 5,
    exp: NOW_SEC + 600,
    ...overrides,
  };
}

export function sessionToken(overrides: Record<string, unknown> = {}, secret: Buffer = SECRET): string {
  return signJwt(sessionPayload(overrides), secret);
}

/** 머리 부분만 올바른 작은 JPEG. 크기 정보(SOF0)까지 담고 나머지는 채움 바이트다. */
export function makeJpeg(options: { width?: number; height?: number; size?: number } = {}): Buffer {
  const width = options.width ?? 512;
  const height = options.height ?? 384;
  const size = options.size ?? 2048;
  const head = Buffer.from([
    0xff, 0xd8, // SOI
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, // APP0
    0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00, // SOF0
  ]);
  const bytes = Buffer.alloc(Math.max(size, head.length + 2), 0x5a);
  head.copy(bytes);
  bytes[bytes.length - 2] = 0xff;
  bytes[bytes.length - 1] = 0xd9; // EOI
  return bytes;
}

export function frame(t: number, bytes: Buffer = makeJpeg()): { t: number; jpeg: string } {
  return { t, jpeg: bytes.toString('base64') };
}

export function framesBody(count: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const frames = Array.from({ length: count }, (_, i) => frame(i * 10));
  return { frames, durationSec: 60, ...extra };
}

export async function* chunked(bytes: Uint8Array, chunkSize = 64 * 1024): AsyncGenerator<Uint8Array> {
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    yield Uint8Array.prototype.slice.call(bytes, offset, offset + chunkSize);
  }
}

export interface RequestOptions {
  method?: string;
  url?: string;
  token?: string | null;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: Uint8Array;
  signal?: AbortSignal;
}

export function analyzeRequest(options: RequestOptions = {}): AppRequest {
  const raw = options.rawBody ?? Buffer.from(JSON.stringify(options.body ?? framesBody(3)), 'utf8');
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = options.token === undefined ? sessionToken() : options.token;
  if (token !== null) headers.authorization = `Bearer ${token}`;
  Object.assign(headers, options.headers);
  return {
    method: options.method ?? 'POST',
    url: options.url ?? '/ai/v1/analyze',
    headers,
    body: chunked(raw),
    signal: options.signal,
  };
}

export function getRequest(url: string, method = 'GET'): AppRequest {
  return { method, url, headers: {}, body: chunked(new Uint8Array(0)) };
}

export function parse(response: AppResponse): Record<string, unknown> {
  return JSON.parse(response.body) as Record<string, unknown>;
}

/** 쓸 수 있는 모델 출력 예시. */
export const GOOD_OUTPUT = {
  summary: '어른과 아이가 블록을 사이에 두고 마주 앉아 있어요. 아이가 블록을 밀어내자 어른이 잠시 기다려요.',
  childStates: ['PLAYING_TOGETHER', 'REFUSING'],
  adultResponses: ['WAITING', 'TALKING'],
  moments: [{ t: 10, note: '아이가 블록을 밀어내요.' }],
  peopleCount: 2,
};

type Step = string | Error | ((request: VisionRequest) => Promise<string>);

export interface FakeProvider extends VisionProvider {
  calls: VisionRequest[];
  readyChecks: number;
  ready: boolean | Error;
}

/** 정해 둔 순서대로 답하는 가짜 제공자. 순서가 끝나면 마지막 답을 되풀이한다. */
export function fakeProvider(steps: Step[] = [JSON.stringify(GOOD_OUTPUT)]): FakeProvider {
  const provider: FakeProvider = {
    modelVersion: 'fake-vl:1',
    calls: [],
    readyChecks: 0,
    ready: true,
    async generate(request) {
      const step = steps[Math.min(provider.calls.length, steps.length - 1)]!;
      provider.calls.push({ ...request, images: [...request.images] });
      if (typeof step === 'string') return step;
      if (step instanceof Error) throw step;
      return step(request);
    },
    async isReady() {
      provider.readyChecks++;
      if (provider.ready instanceof Error) throw provider.ready;
      return provider.ready;
    },
  };
  return provider;
}

/** 신호가 중단될 때까지 끝나지 않는 모델 호출. */
export function untilAborted(request: VisionRequest): Promise<string> {
  return new Promise((_, reject) => {
    request.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
  });
}

export interface TestApp {
  app: App;
  provider: FakeProvider;
  logs: LogEntry[];
  clock: { ms: number };
}

export function testApp(options: { provider?: FakeProvider; config?: Partial<AppDeps['config']>; queue?: AppDeps['queue'] } = {}): TestApp {
  const provider = options.provider ?? fakeProvider();
  const logs: LogEntry[] = [];
  const clock = { ms: NOW_MS };
  const app = createApp({
    config: { secret: SECRET, timeoutMs: 5_000, maxConcurrency: 1, maxWaiting: 2, ...options.config },
    provider,
    now: () => clock.ms,
    log: (entry) => logs.push(entry),
    queue: options.queue,
  });
  return { app, provider, logs, clock };
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (err: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 대기 중인 마이크로태스크와 타이머가 한 바퀴 돌도록 기다린다. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
