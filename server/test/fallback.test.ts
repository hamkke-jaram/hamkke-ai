import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import { PRIMARY_COOLDOWN_MS, createFallbackProvider } from '../src/fallback.ts';
import { buildPrompt } from '../src/prompt.ts';
import { ProviderTimeoutError, ProviderUnavailableError } from '../src/provider.ts';
import type { VisionRequest } from '../src/provider.ts';
import { createProviderFromConfig } from '../src/providers.ts';
import { fakeProvider } from './helpers.ts';

function request(signal: AbortSignal = new AbortController().signal): VisionRequest {
  return { ...buildPrompt([0, 10], 20), images: ['QUJD'], signal };
}

function named(name: string, steps: Parameters<typeof fakeProvider>[0]) {
  return Object.assign(fakeProvider(steps), { modelVersion: name });
}

describe('대신 쓰는 모델', () => {
  it('첫 모델이 되면 첫 모델 이름으로 돌려준다', async () => {
    const primary = named('big-vl', ['A']);
    const fallback = named('small-vl', ['B']);
    const provider = createFallbackProvider(primary, fallback);
    expect(provider.modelVersion).toBe('big-vl');
    expect(provider.fallbackModelVersion).toBe('small-vl');
    expect(await provider.generate(request())).toEqual({ text: 'A', modelVersion: 'big-vl' });
    expect(fallback.calls).toHaveLength(0);
  });

  it('첫 모델에 닿지 못하면 대신 쓰는 모델로 넘어가고 그 이름을 돌려준다', async () => {
    const clock = { ms: 0 };
    const details: string[] = [];
    const primary = named('big-vl', [new ProviderUnavailableError('model_missing'), 'A']);
    const fallback = named('small-vl', ['B']);
    const provider = createFallbackProvider(primary, fallback, { now: () => clock.ms, onFallback: (d) => details.push(d) });
    expect(await provider.generate(request())).toEqual({ text: 'B', modelVersion: 'small-vl' });
    expect(fallback.calls[0]!.images).toEqual(['QUJD']);

    // 잠시 동안은 첫 모델을 건너뛴다.
    clock.ms += PRIMARY_COOLDOWN_MS - 1;
    expect(await provider.generate(request())).toEqual({ text: 'B', modelVersion: 'small-vl' });
    expect(primary.calls).toHaveLength(1);

    // 시간이 지나면 첫 모델을 다시 써 본다.
    clock.ms += 1;
    expect(await provider.generate(request())).toEqual({ text: 'A', modelVersion: 'big-vl' });
    expect(details).toEqual(['model_missing', 'primary_cooldown']);
  });

  it('제한 시간·연결 끊김·그 밖의 오류는 넘기지 않는다', async () => {
    const timeout = createFallbackProvider(named('a', [new ProviderTimeoutError()]), named('b', ['B']));
    await expect(timeout.generate(request())).rejects.toBeInstanceOf(ProviderTimeoutError);

    const controller = new AbortController();
    const aborted = createFallbackProvider(
      named('a', [
        async () => {
          controller.abort();
          throw new ProviderUnavailableError('connect');
        },
      ]),
      named('b', ['B']),
    );
    await expect(aborted.generate(request(controller.signal))).rejects.toBeInstanceOf(ProviderUnavailableError);

    const bug = createFallbackProvider(named('a', [new TypeError('boom')]), named('b', ['B']));
    await expect(bug.generate(request())).rejects.toBeInstanceOf(TypeError);
  });

  it('둘 다 안 되면 대신 쓰는 모델의 오류를 그대로 던진다', async () => {
    const provider = createFallbackProvider(
      named('a', [new ProviderUnavailableError('connect')]),
      named('b', [new ProviderUnavailableError('chat_http_500')]),
    );
    await expect(provider.generate(request())).rejects.toMatchObject({ detail: 'chat_http_500' });
  });

  it('둘 가운데 하나라도 쓸 수 있으면 준비된 것으로 본다', async () => {
    const primary = named('a', ['A']);
    const fallback = named('b', ['B']);
    const provider = createFallbackProvider(primary, fallback);
    const signal = new AbortController().signal;
    primary.ready = false;
    expect(await provider.isReady(signal)).toBe(true);
    fallback.ready = new Error('down');
    expect(await provider.isReady(signal)).toBe(false);
    primary.ready = true;
    expect(await provider.isReady(signal)).toBe(true);
  });

  it('미리 올리기는 첫 모델만 한다', async () => {
    const warmed: string[] = [];
    const primary = Object.assign(named('a', ['A']), { warmUp: async () => void warmed.push('a') });
    const fallback = Object.assign(named('b', ['B']), { warmUp: async () => void warmed.push('b') });
    await createFallbackProvider(primary, fallback).warmUp!(new AbortController().signal);
    expect(warmed).toEqual(['a']);
  });
});

describe('환경 변수로 제공자 만들기', () => {
  it('VL_FALLBACK_MODEL 이 없으면 Ollama 하나, 있으면 대신 쓰는 모델을 붙이고 인증 헤더를 둘 다 보낸다', async () => {
    const single = createProviderFromConfig(loadConfig({}));
    expect(single.fallbackModelVersion).toBeUndefined();

    const seen: { url: string; auth: string | undefined }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push({ url, auth: (init?.headers as Record<string, string>).Authorization });
      if (url.startsWith('http://gpu-a:11434')) throw new TypeError('fetch failed');
      if (url.endsWith('/api/show')) return Response.json({ capabilities: ['vision'] });
      return Response.json({ message: { content: 'B' } });
    }) as typeof fetch;
    const provider = createProviderFromConfig(
      loadConfig({
        OLLAMA_URL: 'http://gpu-a:11434',
        VL_FALLBACK_MODEL: 'small-vl:2b',
        VL_FALLBACK_URL: 'http://gpu-b:11434',
        OLLAMA_AUTH_TOKEN: 'proxy-token-123',
      }),
      { fetchImpl },
    );
    expect(provider.fallbackModelVersion).toBe('small-vl:2b');
    expect(await provider.generate(request())).toEqual({ text: 'B', modelVersion: 'small-vl:2b' });
    expect(seen.map((s) => s.url)).toEqual([
      'http://gpu-a:11434/api/show',
      'http://gpu-b:11434/api/show',
      'http://gpu-b:11434/api/chat',
    ]);
    expect(seen.every((s) => s.auth === 'Bearer proxy-token-123')).toBe(true);
  });
});
