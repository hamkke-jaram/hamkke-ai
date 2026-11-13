// 환경 변수 읽기. 잘못된 값은 서버를 띄우기 전에 알려 준다.

/** 개발용 기본 비밀. NODE_ENV 가 production 이면 쓸 수 없다. */
export const DEV_SHARED_SECRET = 'local-dev-only-ai-shared-secret-change-me-0123456789';
const MIN_SECRET_BYTES = 32;

export interface Config {
  production: boolean;
  host: string;
  port: number;
  /** AI_SHARED_SECRET 문자열의 UTF-8 바이트. */
  secret: Buffer;
  usingDevSecret: boolean;
  ollamaUrl: string;
  model: string;
  maxConcurrency: number;
  maxWaiting: number;
  timeoutMs: number;
  /** 차례를 기다리는 시간의 상한(밀리초). */
  maxWaitMs: number;
  keepAlive: string | null;
  numCtx: number;
  maxOutputTokens: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

function text(env: Env, name: string): string | null {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? null : value;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = text(env, name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ConfigError(`${name} 은(는) ${min}~${max} 사이의 정수여야 해요.`);
  }
  return value;
}

export function loadConfig(env: Env): Config {
  const production = env.NODE_ENV === 'production';

  let secretText = text(env, 'AI_SHARED_SECRET');
  let usingDevSecret = false;
  if (secretText === null) {
    if (production) throw new ConfigError('AI_SHARED_SECRET 이 필요해요(hamkke-api 와 같은 값).');
    secretText = DEV_SHARED_SECRET;
    usingDevSecret = true;
  } else if (secretText === DEV_SHARED_SECRET) {
    if (production) throw new ConfigError('AI_SHARED_SECRET 에 개발용 기본값을 쓸 수 없어요.');
    usingDevSecret = true;
  }
  const secret = Buffer.from(secretText, 'utf8');
  if (secret.length < MIN_SECRET_BYTES) {
    throw new ConfigError(`AI_SHARED_SECRET 은 ${MIN_SECRET_BYTES}바이트 이상이어야 해요.`);
  }

  const ollamaUrl = text(env, 'OLLAMA_URL') ?? 'http://localhost:11434';
  let parsed: URL;
  try {
    parsed = new URL(ollamaUrl);
  } catch {
    throw new ConfigError('OLLAMA_URL 이 주소 형식이 아니에요.');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError('OLLAMA_URL 은 http 또는 https 주소여야 해요.');
  }

  const timeoutMs = integer(env, 'VL_TIMEOUT_MS', 180_000, 1_000, 600_000);

  return {
    production,
    // 컨테이너 안에서는 밖에서 닿을 수 있어야 하고, 개발할 때는 이 기기에서만 받는다.
    host: text(env, 'HOST') ?? (production ? '0.0.0.0' : '127.0.0.1'),
    port: integer(env, 'PORT', 8090, 1, 65535),
    secret,
    usingDevSecret,
    ollamaUrl,
    model: text(env, 'VL_MODEL') ?? 'qwen3.5:4b',
    maxConcurrency: integer(env, 'VL_MAX_CONCURRENCY', 1, 1, 16),
    maxWaiting: integer(env, 'VL_MAX_WAITING', 2, 0, 100),
    timeoutMs,
    // 기본값은 제한 시간의 절반: 오래 기다린 요청은 429 로 돌려보내 모델 호출에 적어도 절반을 남긴다.
    maxWaitMs: integer(env, 'VL_MAX_WAIT_MS', Math.floor(timeoutMs / 2), 0, timeoutMs),
    keepAlive: text(env, 'VL_KEEP_ALIVE'),
    numCtx: integer(env, 'VL_NUM_CTX', 8192, 2048, 131_072),
    maxOutputTokens: integer(env, 'VL_MAX_OUTPUT_TOKENS', 480, 64, 4096),
  };
}
