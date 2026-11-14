// Ollama 제공자. POST {OLLAMA_URL}/api/chat 한 번으로 사진과 지시문을 보내고 JSON 글을 받는다.
// 응답 본문이나 사진은 어디에도 남기지 않는다. 실패는 짧은 코드로만 알린다.
import { ProviderUnavailableError } from './provider.ts';
import type { VisionProvider, VisionRequest } from './provider.ts';

/** 모델 서버에 보낼 인증 헤더(OLLAMA_AUTH_TOKEN). 값은 로그·오류 코드에 넣지 않는다. */
export interface ProviderAuthHeader {
  name: string;
  value: string;
}

export interface OllamaOptions {
  baseUrl: string;
  model: string;
  /** 모델을 메모리에 얼마나 둘지(Ollama keep_alive). null 이면 Ollama 기본값. */
  keepAlive: string | null;
  /** 사진 6장과 지시문이 들어갈 문맥 길이. */
  numCtx: number;
  /** 한 번에 만들 수 있는 토큰 수 상한. */
  maxOutputTokens: number;
  /** Ollama 앞의 TLS 프록시 등이 요구하는 인증 헤더. 없으면 null. */
  authHeader?: ProviderAuthHeader | null;
  /** 테스트에서 바꿔 끼우는 fetch. */
  fetchImpl?: typeof fetch;
}

interface ModelTraits {
  present: boolean;
  vision: boolean;
  thinking: boolean;
}

const TEMPERATURE = 0.2;

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 이미 닫힌 본문
  }
}

export function createOllamaProvider(options: OllamaOptions): VisionProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const keepAlive =
    options.keepAlive === null ? undefined : /^-?\d+$/.test(options.keepAlive) ? Number(options.keepAlive) : options.keepAlive;
  let traits: ModelTraits | null = null;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.authHeader) headers[options.authHeader.name] = options.authHeader.value;

  async function post(path: string, body: unknown, signal: AbortSignal): Promise<Response> {
    try {
      return await doFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (isAbort(err) || signal.aborted) throw err;
      throw new ProviderUnavailableError('connect');
    }
  }

  /** 모델이 설치되어 있는지, 사진을 볼 수 있는지, 생각 단계를 끌 수 있는지 알아본다. */
  async function inspect(signal: AbortSignal): Promise<ModelTraits> {
    const response = await post('/api/show', { model: options.model }, signal);
    if (response.status === 404) {
      await discard(response);
      return { present: false, vision: false, thinking: false };
    }
    if (response.status === 401 || response.status === 403) {
      await discard(response);
      throw new ProviderUnavailableError('auth_rejected');
    }
    if (!response.ok) {
      await discard(response);
      throw new ProviderUnavailableError(`show_http_${response.status}`);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      if (isAbort(err) || signal.aborted) throw err;
      throw new ProviderUnavailableError('show_bad_response');
    }
    const capabilities = isPlainObject(data) && Array.isArray(data.capabilities) ? data.capabilities : null;
    // 능력 목록을 주지 않는 옛 버전이면 사진은 된다고 보고, 생각 단계 설정은 보내지 않는다.
    return {
      present: true,
      vision: capabilities === null || capabilities.includes('vision'),
      thinking: capabilities !== null && capabilities.includes('thinking'),
    };
  }

  async function generate(request: VisionRequest): Promise<string> {
    if (traits === null || !traits.present) traits = await inspect(request.signal);
    if (!traits.present) throw new ProviderUnavailableError('model_missing');
    if (!traits.vision) throw new ProviderUnavailableError('model_without_vision');

    const body: Record<string, unknown> = {
      model: options.model,
      stream: false,
      messages: [
        { role: 'system', content: request.system },
        { role: 'user', content: request.user, images: request.images },
      ],
      format: request.schema,
      options: { temperature: TEMPERATURE, num_predict: options.maxOutputTokens, num_ctx: options.numCtx },
    };
    // 생각 단계를 켜 두면 응답이 몇 배 느려진다. 끌 수 있는 모델에서만 끈다(못 끄는 모델에 보내면 400).
    if (traits.thinking) body.think = false;
    if (keepAlive !== undefined) body.keep_alive = keepAlive;

    const response = await post('/api/chat', body, request.signal);
    if (!response.ok) {
      await discard(response);
      if (response.status === 404) traits = null; // 모델이 지워졌을 수 있으니 다음에 다시 알아본다
      if (response.status === 401 || response.status === 403) throw new ProviderUnavailableError('auth_rejected');
      throw new ProviderUnavailableError(`chat_http_${response.status}`);
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch (err) {
      if (isAbort(err) || request.signal.aborted) throw err;
      throw new ProviderUnavailableError('chat_bad_response');
    }
    const message = isPlainObject(data) ? data.message : undefined;
    const content = isPlainObject(message) ? message.content : undefined;
    if (typeof content !== 'string') throw new ProviderUnavailableError('chat_bad_response');
    return content;
  }

  async function isReady(signal: AbortSignal): Promise<boolean> {
    try {
      traits = await inspect(signal);
      return traits.present && traits.vision;
    } catch {
      return false;
    }
  }

  /**
   * 모델을 메모리에 올려 둔다. 프롬프트 없이 /api/generate 를 부르면 Ollama 는 모델만 불러오고 끝낸다.
   * 사진도 문장도 보내지 않는다. keep_alive 를 함께 보내 정해 둔 시간 동안 내려가지 않게 한다.
   */
  async function warmUp(signal: AbortSignal): Promise<void> {
    if (traits === null || !traits.present) traits = await inspect(signal);
    if (!traits.present) throw new ProviderUnavailableError('model_missing');
    const body: Record<string, unknown> = { model: options.model, stream: false };
    if (keepAlive !== undefined) body.keep_alive = keepAlive;
    const response = await post('/api/generate', body, signal);
    await discard(response);
    if (!response.ok) throw new ProviderUnavailableError(`warmup_http_${response.status}`);
  }

  return { modelVersion: options.model, generate, isReady, warmUp };
}
