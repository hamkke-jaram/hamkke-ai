// 환경 변수 읽기. 잘못된 값은 서버를 띄우기 전에 알려 준다.
// 이 파일이 읽는 이름은 모두 docs/observation.md 2장 표에 있어야 한다(server/test/config.test.ts 가 확인한다).
import { isIP } from 'node:net';

/** 개발용 기본 비밀. NODE_ENV 가 production 이면 쓸 수 없다. */
export const DEV_SHARED_SECRET = 'local-dev-only-ai-shared-secret-change-me-0123456789';
const MIN_SECRET_BYTES = 32;
const MIN_METRICS_TOKEN_LENGTH = 16;
/** hamkke-api 가 영수증 mv 로 받는 최대 길이(AiReceiptVerifier.MAX_MODEL_VERSION_CHARS). */
export const MAX_MODEL_NAME_LENGTH = 100;

/** 모델 서버에 보낼 인증 헤더. 값은 로그에 남기지 않는다. */
export interface AuthHeader {
  name: string;
  value: string;
}

export interface Config {
  production: boolean;
  host: string;
  port: number;
  /** AI_SHARED_SECRET 문자열의 UTF-8 바이트. */
  secret: Buffer;
  usingDevSecret: boolean;
  ollamaUrl: string;
  model: string;
  /** 첫 모델을 쓸 수 없을 때 대신 쓰는 모델. null 이면 대신 쓰지 않는다. */
  fallbackModel: string | null;
  /** 대신 쓰는 모델의 Ollama 주소. 정하지 않으면 ollamaUrl. */
  fallbackUrl: string;
  /** 모델 서버(Ollama 또는 그 앞의 TLS 프록시)에 보낼 인증 헤더. */
  ollamaAuth: AuthHeader | null;
  /** 서버가 뜬 뒤 모델을 미리 메모리에 올려 둘지. */
  warmup: boolean;
  maxConcurrency: number;
  maxWaiting: number;
  timeoutMs: number;
  /** 차례를 기다리는 시간의 상한(밀리초). */
  maxWaitMs: number;
  keepAlive: string | null;
  numCtx: number;
  maxOutputTokens: number;
  /** GET /ai/v1/metrics 에 필요한 Bearer 토큰. null 이면 토큰 없이 열린다(nginx 가 밖에서 막는다). */
  metricsToken: string | null;
  /** 서버를 띄울 때 남길 경고(설정은 쓸 수 있지만 확인이 필요한 것). 비밀 값은 담지 않는다. */
  warnings: string[];
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

function flag(env: Env, name: string): boolean {
  const raw = text(env, name);
  if (raw === null) return false;
  const value = raw.toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes') return true;
  if (value === 'false' || value === '0' || value === 'no') return false;
  throw new ConfigError(`${name} 은(는) true 또는 false 여야 해요.`);
}

function ipv4InPrivateRange(address: string): boolean {
  const [a, b] = address.split('.').map(Number) as [number, number];
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT·사설 오버레이 망(예: Tailscale)
  );
}

/**
 * 사진이 지나가도 되는 '안쪽' 주소인지: 이 기기, 사설 IP, 점이 없는 이름(compose 서비스 이름),
 * 사설망에서만 쓰는 이름(.internal, .local, .lan, .home.arpa, .localhost).
 * 그 밖의 이름이나 공인 IP 는 바깥 주소로 본다.
 */
export function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const kind = isIP(host);
  if (kind === 4) return ipv4InPrivateRange(host);
  if (kind === 6) {
    if (host === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(host);
    if (mapped) return ipv4InPrivateRange(mapped[1]!);
    return /^f[cd][0-9a-f]{0,2}:/.test(host) || /^fe[89ab][0-9a-f]?:/.test(host);
  }
  if (host === 'localhost' || !host.includes('.')) return true;
  return /\.(internal|local|lan|localhost|home\.arpa)$/.test(host);
}

/** 모델 서버 주소를 검사한다. 바깥 주소로 사진을 평문(http)으로 보내는 설정은 production 에서 막는다. */
function modelServerUrl(name: string, value: string, production: boolean, allowInsecure: boolean, warnings: string[]): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`${name} 이 주소 형식이 아니에요.`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ConfigError(`${name} 은 http 또는 https 주소여야 해요.`);
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new ConfigError(`${name} 에 사용자 이름이나 비밀번호를 넣지 말고 OLLAMA_AUTH_TOKEN 을 써 주세요.`);
  }
  if (parsed.protocol === 'http:' && !isPrivateHost(parsed.hostname)) {
    const message = `${name} 이 바깥 주소를 http 로 가리켜요. 장면 사진이 암호화되지 않은 채 지나가니 https(TLS 프록시)나 사설망을 써 주세요.`;
    if (production && !allowInsecure) {
      throw new ConfigError(`${message} 꼭 이대로 써야 하면 OLLAMA_ALLOW_INSECURE=true 로 둘 수 있어요.`);
    }
    warnings.push(message);
  }
  return value;
}

/** 모델 이름은 영수증 mv 로 나간다. hamkke-api 가 받지 않는 이름이면 기록이 저장되지 않으므로 미리 막는다. */
function modelName(env: Env, name: string, fallback: string | null): string | null {
  const value = text(env, name) ?? fallback;
  if (value !== null && (value.length > MAX_MODEL_NAME_LENGTH || !/^[!-~]+$/.test(value))) {
    throw new ConfigError(`${name} 은(는) 공백 없는 ${MAX_MODEL_NAME_LENGTH}자 이하 이름이어야 해요.`);
  }
  return value;
}

function authHeader(env: Env): AuthHeader | null {
  const token = text(env, 'OLLAMA_AUTH_TOKEN');
  const headerName = text(env, 'OLLAMA_AUTH_HEADER');
  const name = headerName ?? 'Authorization';
  if (!/^[A-Za-z0-9-]{1,64}$/.test(name)) {
    throw new ConfigError('OLLAMA_AUTH_HEADER 는 영문·숫자·하이픈으로 된 헤더 이름이어야 해요.');
  }
  if (token === null) {
    if (headerName !== null) throw new ConfigError('OLLAMA_AUTH_HEADER 를 쓰려면 OLLAMA_AUTH_TOKEN 도 채워 주세요.');
    return null;
  }
  // 헤더 값에 줄바꿈이나 보이지 않는 글자가 섞이면 다른 헤더를 끼워 넣을 수 있다.
  if (!/^[\x21-\x7e]{1,4096}$/.test(token)) {
    throw new ConfigError('OLLAMA_AUTH_TOKEN 에는 공백 없는 영문·숫자·기호만 쓸 수 있어요.');
  }
  const value = name.toLowerCase() === 'authorization' ? `Bearer ${token}` : token;
  return { name, value };
}

export function loadConfig(env: Env): Config {
  const production = env.NODE_ENV === 'production';
  const warnings: string[] = [];

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

  const allowInsecure = flag(env, 'OLLAMA_ALLOW_INSECURE');
  const ollamaUrl = modelServerUrl('OLLAMA_URL', text(env, 'OLLAMA_URL') ?? 'http://localhost:11434', production, allowInsecure, warnings);
  const model = modelName(env, 'VL_MODEL', 'qwen3.5:4b')!;

  const fallbackModel = modelName(env, 'VL_FALLBACK_MODEL', null);
  const fallbackUrlText = text(env, 'VL_FALLBACK_URL');
  if (fallbackUrlText !== null && fallbackModel === null) {
    throw new ConfigError('VL_FALLBACK_URL 을 쓰려면 VL_FALLBACK_MODEL 도 채워 주세요.');
  }
  const fallbackUrl =
    fallbackUrlText === null ? ollamaUrl : modelServerUrl('VL_FALLBACK_URL', fallbackUrlText, production, allowInsecure, warnings);
  const sameServer = fallbackUrl.replace(/\/+$/, '') === ollamaUrl.replace(/\/+$/, '');
  if (fallbackModel !== null && fallbackModel === model && sameServer) {
    throw new ConfigError('VL_FALLBACK_MODEL 이 VL_MODEL 과 같은 서버의 같은 모델이에요. 다른 모델이나 다른 서버를 정해 주세요.');
  }

  const metricsToken = text(env, 'METRICS_TOKEN');
  if (metricsToken !== null) {
    if (!/^[A-Za-z0-9._~+/=-]+$/.test(metricsToken) || metricsToken.length < MIN_METRICS_TOKEN_LENGTH) {
      throw new ConfigError(`METRICS_TOKEN 은 공백 없는 ${MIN_METRICS_TOKEN_LENGTH}자 이상이어야 해요.`);
    }
    if (metricsToken === secretText) {
      throw new ConfigError('METRICS_TOKEN 은 AI_SHARED_SECRET 과 다른 값이어야 해요.');
    }
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
    model,
    fallbackModel,
    fallbackUrl,
    ollamaAuth: authHeader(env),
    warmup: flag(env, 'VL_WARMUP'),
    maxConcurrency: integer(env, 'VL_MAX_CONCURRENCY', 1, 1, 16),
    maxWaiting: integer(env, 'VL_MAX_WAITING', 2, 0, 100),
    timeoutMs,
    // 기본값은 제한 시간의 절반: 오래 기다린 요청은 429 로 돌려보내 모델 호출에 적어도 절반을 남긴다.
    maxWaitMs: integer(env, 'VL_MAX_WAIT_MS', Math.floor(timeoutMs / 2), 0, timeoutMs),
    keepAlive: text(env, 'VL_KEEP_ALIVE'),
    numCtx: integer(env, 'VL_NUM_CTX', 8192, 2048, 131_072),
    maxOutputTokens: integer(env, 'VL_MAX_OUTPUT_TOKENS', 480, 64, 4096),
    metricsToken,
    warnings,
  };
}
