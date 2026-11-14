import { describe, expect, it } from 'vitest';
import { createOllamaProvider } from '../src/ollama.ts';
import { buildPrompt } from '../src/prompt.ts';
import { ProviderUnavailableError } from '../src/provider.ts';
import type { VisionRequest } from '../src/provider.ts';

interface Call {
  url: string;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

type Reply = Response | Error | ((call: Call) => Response | Promise<Response>);

function jsonReply(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}

const SHOW_VL = { capabilities: ['completion', 'vision', 'thinking'] };

/** 주소별로 정해 둔 답을 돌려주는 가짜 fetch. 실제 연결은 하지 않는다. */
function fakeFetch(replies: Record<string, Reply[]>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const call: Call = { url, body: JSON.parse(String(init?.body)) as Record<string, unknown>, signal: init?.signal };
    calls.push(call);
    const path = new URL(url).pathname;
    const queue = replies[path];
    const reply = queue?.shift();
    if (reply === undefined) throw new Error(`unexpected request to ${path}`);
    if (reply instanceof Error) throw reply;
    return reply instanceof Response ? reply : reply(call);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function request(signal: AbortSignal = new AbortController().signal): VisionRequest {
  return { ...buildPrompt([0, 10], 20), images: ['QUJD', 'REVG'], signal };
}

function provider(fetchImpl: typeof fetch, keepAlive: string | null = null) {
  return createOllamaProvider({
    baseUrl: 'http://ollama.test:11434/',
    model: 'qwen3.5:4b',
    keepAlive,
    numCtx: 8192,
    maxOutputTokens: 480,
    fetchImpl,
  });
}

async function detailOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ProviderUnavailableError) return err.detail;
    throw err;
  }
  return 'resolved';
}

describe('Ollama 제공자', () => {
  it('/api/chat 에 사진과 지시문, JSON 스키마를 한 번에 보낸다', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/api/show': [jsonReply(SHOW_VL)],
      '/api/chat': [jsonReply({ message: { role: 'assistant', content: '{"peopleCount":1}', thinking: '' }, done: true })],
    });
    const input = request();
    const text = await provider(fetchImpl).generate(input);
    expect(text).toBe('{"peopleCount":1}');

    expect(calls.map((c) => c.url)).toEqual(['http://ollama.test:11434/api/show', 'http://ollama.test:11434/api/chat']);
    expect(calls[0]!.body).toEqual({ model: 'qwen3.5:4b' });
    const chat = calls[1]!.body;
    expect(chat.model).toBe('qwen3.5:4b');
    expect(chat.stream).toBe(false);
    expect(chat.think).toBe(false);
    expect(chat.format).toEqual(input.schema);
    expect(chat.options).toEqual({ temperature: 0.2, num_predict: 480, num_ctx: 8192 });
    expect(chat.messages).toEqual([
      { role: 'system', content: input.system },
      { role: 'user', content: input.user, images: ['QUJD', 'REVG'] },
    ]);
    expect('keep_alive' in chat).toBe(false);
    expect(calls[1]!.signal).toBe(input.signal);
  });

  it('모델 정보는 한 번만 알아보고, keep_alive 를 넘긴다', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/api/show': [jsonReply(SHOW_VL)],
      '/api/chat': [jsonReply({ message: { content: 'a' } }), jsonReply({ message: { content: 'b' } })],
    });
    const p = provider(fetchImpl, '30m');
    expect(await p.generate(request())).toBe('a');
    expect(await p.generate(request())).toBe('b');
    expect(calls.filter((c) => c.url.endsWith('/api/show'))).toHaveLength(1);
    expect(calls[1]!.body.keep_alive).toBe('30m');
  });

  it('숫자로 적은 keep_alive 는 숫자로 보낸다', async () => {
    const { fetchImpl, calls } = fakeFetch({ '/api/show': [jsonReply(SHOW_VL)], '/api/chat': [jsonReply({ message: { content: 'a' } })] });
    await provider(fetchImpl, '-1').generate(request());
    expect(calls[1]!.body.keep_alive).toBe(-1);
  });

  it('생각 단계가 없는 모델에는 think 를 보내지 않는다', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/api/show': [jsonReply({ capabilities: ['completion', 'vision'] })],
      '/api/chat': [jsonReply({ message: { content: 'a' } })],
    });
    await provider(fetchImpl).generate(request());
    expect('think' in calls[1]!.body).toBe(false);
  });

  it('연결하지 못하면 connect', async () => {
    const { fetchImpl } = fakeFetch({ '/api/show': [new TypeError('fetch failed')] });
    expect(await detailOf(provider(fetchImpl).generate(request()))).toBe('connect');
  });

  it('모델이 설치되어 있지 않으면 model_missing', async () => {
    const { fetchImpl } = fakeFetch({ '/api/show': [jsonReply({ error: 'model not found' }, 404)] });
    expect(await detailOf(provider(fetchImpl).generate(request()))).toBe('model_missing');
  });

  it('사진을 못 보는 모델이면 부르지 않는다', async () => {
    const { fetchImpl, calls } = fakeFetch({ '/api/show': [jsonReply({ capabilities: ['completion'] })] });
    expect(await detailOf(provider(fetchImpl).generate(request()))).toBe('model_without_vision');
    expect(calls).toHaveLength(1);
  });

  it('HTTP 오류는 상태 값만 남긴다', async () => {
    const { fetchImpl } = fakeFetch({
      '/api/show': [jsonReply(SHOW_VL)],
      '/api/chat': [jsonReply({ error: 'boom with details' }, 500)],
    });
    expect(await detailOf(provider(fetchImpl).generate(request()))).toBe('chat_http_500');
  });

  it('응답이 JSON 이 아니거나 글이 없으면 chat_bad_response', async () => {
    const { fetchImpl } = fakeFetch({
      '/api/show': [jsonReply(SHOW_VL)],
      '/api/chat': [new Response('<html>'), jsonReply({ message: {} }), jsonReply({ done: true })],
    });
    const p = provider(fetchImpl);
    expect(await detailOf(p.generate(request()))).toBe('chat_bad_response');
    expect(await detailOf(p.generate(request()))).toBe('chat_bad_response');
    expect(await detailOf(p.generate(request()))).toBe('chat_bad_response');
  });

  it('중단 신호로 끊긴 호출은 연결 실패로 바꾸지 않는다', async () => {
    const controller = new AbortController();
    const { fetchImpl } = fakeFetch({
      '/api/show': [jsonReply(SHOW_VL)],
      '/api/chat': [
        (call) =>
          new Promise<Response>((_, reject) => {
            call.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      ],
    });
    const pending = provider(fetchImpl).generate(request(controller.signal));
    setTimeout(() => controller.abort(), 5);
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('isReady: 모델이 있고 사진을 볼 수 있을 때만 true', async () => {
    const signal = new AbortController().signal;
    const ready = fakeFetch({ '/api/show': [jsonReply(SHOW_VL)] });
    expect(await provider(ready.fetchImpl).isReady(signal)).toBe(true);
    expect(ready.calls[0]!.body).toEqual({ model: 'qwen3.5:4b' });

    const missing = fakeFetch({ '/api/show': [jsonReply({ error: 'not found' }, 404)] });
    expect(await provider(missing.fetchImpl).isReady(signal)).toBe(false);

    const blind = fakeFetch({ '/api/show': [jsonReply({ capabilities: ['completion'] })] });
    expect(await provider(blind.fetchImpl).isReady(signal)).toBe(false);

    const down = fakeFetch({ '/api/show': [new TypeError('fetch failed')] });
    expect(await provider(down.fetchImpl).isReady(signal)).toBe(false);

    const broken = fakeFetch({ '/api/show': [jsonReply({}, 500)] });
    expect(await provider(broken.fetchImpl).isReady(signal)).toBe(false);
  });

  it('능력 목록을 주지 않는 옛 버전이면 사진은 된다고 본다', async () => {
    const { fetchImpl, calls } = fakeFetch({
      '/api/show': [jsonReply({ details: {} })],
      '/api/chat': [jsonReply({ message: { content: 'a' } })],
    });
    expect(await provider(fetchImpl).generate(request())).toBe('a');
    expect('think' in calls[1]!.body).toBe(false);
  });
});

describe('Ollama 제공자 — 인증 헤더와 미리 올리기', () => {
  /** 헤더까지 기록하는 가짜 fetch. */
  function recordingFetch(reply: (path: string, body: Record<string, unknown>) => Response) {
    const seen: { path: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      seen.push({ path, headers: { ...(init?.headers as Record<string, string>) }, body });
      return reply(path, body);
    }) as typeof fetch;
    return { fetchImpl, seen };
  }

  function withAuth(fetchImpl: typeof fetch, authHeader: { name: string; value: string } | null, keepAlive: string | null = null) {
    return createOllamaProvider({
      baseUrl: 'https://ollama.example.kr',
      model: 'qwen3.5:4b',
      keepAlive,
      numCtx: 8192,
      maxOutputTokens: 480,
      authHeader,
      fetchImpl,
    });
  }

  it('인증 헤더를 모든 요청에 붙이고, 없으면 붙이지 않는다', async () => {
    const reply = (path: string) => (path === '/api/show' ? jsonReply(SHOW_VL) : jsonReply({ message: { content: 'a' } }));
    const authed = recordingFetch(reply);
    await withAuth(authed.fetchImpl, { name: 'Authorization', value: 'Bearer secret-token' }).generate(request());
    expect(authed.seen.map((s) => s.headers.Authorization)).toEqual(['Bearer secret-token', 'Bearer secret-token']);
    expect(authed.seen[0]!.headers['Content-Type']).toBe('application/json');

    const plain = recordingFetch(reply);
    await withAuth(plain.fetchImpl, null).generate(request());
    expect(plain.seen.every((s) => !('Authorization' in s.headers))).toBe(true);
  });

  it('인증이 거절되면 auth_rejected (토큰 값은 오류에 없다)', async () => {
    const { fetchImpl } = recordingFetch(() => jsonReply({ error: 'unauthorized' }, 401));
    const p = withAuth(fetchImpl, { name: 'X-Api-Key', value: 'secret-token' });
    const detail = await detailOf(p.generate(request()));
    expect(detail).toBe('auth_rejected');
    expect(await p.isReady(new AbortController().signal)).toBe(false);
  });

  it('모델 정보를 알아본 뒤 /api/chat 에서 거절돼도 auth_rejected', async () => {
    const { fetchImpl } = recordingFetch((path) => (path === '/api/show' ? jsonReply(SHOW_VL) : jsonReply({ error: 'forbidden' }, 403)));
    expect(await detailOf(withAuth(fetchImpl, { name: 'Authorization', value: 'Bearer secret-token' }).generate(request()))).toBe(
      'auth_rejected',
    );
  });

  it('미리 올리기: 프롬프트·사진 없이 /api/generate 에 모델과 keep_alive 만 보낸다', async () => {
    const { fetchImpl, seen } = recordingFetch((path) =>
      path === '/api/show' ? jsonReply(SHOW_VL) : jsonReply({ model: 'qwen3.5:4b', done: true, done_reason: 'load' }),
    );
    await withAuth(fetchImpl, null, '30m').warmUp!(new AbortController().signal);
    expect(seen.map((s) => s.path)).toEqual(['/api/show', '/api/generate']);
    expect(seen[1]!.body).toEqual({ model: 'qwen3.5:4b', stream: false, keep_alive: '30m' });
  });

  it('미리 올리기: 모델이 없거나 HTTP 오류면 짧은 코드로 알린다', async () => {
    const missing = recordingFetch(() => jsonReply({ error: 'not found' }, 404));
    expect(await detailOf(withAuth(missing.fetchImpl, null).warmUp!(new AbortController().signal))).toBe('model_missing');
    const broken = recordingFetch((path) => (path === '/api/show' ? jsonReply(SHOW_VL) : jsonReply({}, 500)));
    expect(await detailOf(withAuth(broken.fetchImpl, null).warmUp!(new AbortController().signal))).toBe('warmup_http_500');
  });
});
