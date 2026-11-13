import { describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES, MAX_FRAME_BYTES } from '../src/frames.ts';
import { verifyJwt } from '../src/jwt.ts';
import { PROMPT_VERSION } from '../src/prompt.ts';
import { ProviderTimeoutError, ProviderUnavailableError } from '../src/provider.ts';
import { QueueAbortedError } from '../src/queue.ts';
import type { WorkQueue } from '../src/queue.ts';
import { EVALUATIVE_TERMS } from '../src/wording.ts';
import {
  GOOD_OUTPUT,
  NOW_SEC,
  OTHER_SECRET,
  SECRET,
  analyzeRequest,
  chunked,
  deferred,
  fakeProvider,
  frame,
  framesBody,
  getRequest,
  makeJpeg,
  parse,
  sessionPayload,
  sessionToken,
  testApp,
  tick,
  untilAborted,
} from './helpers.ts';

const GOOD = JSON.stringify(GOOD_OUTPUT);

describe('POST /ai/v1/analyze — 성공', () => {
  it('관찰 기록과 영수증을 돌려준다', async () => {
    const { app, provider } = testApp();
    const payload = sessionPayload({ src: 'INSTITUTION', sub: '99', cid: 12 });
    const response = await app.handle(
      analyzeRequest({ token: sessionToken(payload), body: { frames: [frame(20), frame(0), frame(10)], durationSec: 30 } }),
    );
    expect(response.status).toBe(200);
    const body = parse(response);
    expect(body.observation).toEqual(GOOD_OUTPUT);
    expect(body.modelVersion).toBe('fake-vl:1');
    expect(body.promptVersion).toBe(PROMPT_VERSION);
    expect(body.analyzedFrames).toBe(3);
    expect(Object.keys(body).sort()).toEqual(['analyzedFrames', 'modelVersion', 'observation', 'promptVersion', 'receipt']);

    // 영수증: 서명이 맞고, 분석 토큰의 값과 검사를 마친 관찰 기록이 들어 있다.
    expect(verifyJwt(body.receipt as string, SECRET)).toEqual({
      iss: 'hamkke-ai',
      aud: 'hamkke-api',
      sub: '99',
      cid: 12,
      src: 'INSTITUTION',
      jti: payload.jti,
      obs: GOOD_OUTPUT,
      mv: 'fake-vl:1',
      pv: 'obs-v1',
      fc: 3,
      iat: NOW_SEC,
      exp: NOW_SEC + 900,
    });
    expect(() => verifyJwt(body.receipt as string, OTHER_SECRET)).toThrowError();

    // 모델에는 사진이 시각 순서대로 가고, 각 사진의 시각을 알려 준다.
    expect(provider.calls).toHaveLength(1);
    const call = provider.calls[0]!;
    expect(call.images).toHaveLength(3);
    expect(call.user).toContain('사진 3장');
    expect(call.user).toContain('- 사진 2: t=10');
    expect(call.user).toContain('약 30초');
    expect(call.system).toContain('THROWING_OR_HITTING');
  });

  it('응답에 CORS 헤더가 없고 캐시하지 않게 한다', async () => {
    const { app } = testApp();
    const response = await app.handle(analyzeRequest({ headers: { origin: 'https://elsewhere.example' } }));
    expect(response.status).toBe(200);
    const names = Object.keys(response.headers).map((name) => name.toLowerCase());
    expect(names.some((name) => name.startsWith('access-control-'))).toBe(false);
    expect(response.headers['Cache-Control']).toBe('no-store');
    expect(response.headers['Content-Type']).toBe('application/json; charset=utf-8');
    expect(response.headers['X-Request-Id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('로그 한 줄에는 사진도 문장도 토큰도 없다', async () => {
    const { app, logs } = testApp();
    const token = sessionToken();
    const body = framesBody(2);
    await app.handle(analyzeRequest({ token, body }));
    expect(logs).toHaveLength(1);
    const entry = logs[0]!;
    expect(entry).toMatchObject({ route: 'analyze', frames: 2, status: 200, code: 'OK', attempts: 1 });
    expect(entry.bytes).toBe(Buffer.byteLength(JSON.stringify(body)));
    expect(entry.jti).toMatch(/^[0-9a-f]{12}$/);
    const line = JSON.stringify(entry);
    expect(line).not.toContain(GOOD_OUTPUT.summary);
    expect(line).not.toContain(GOOD_OUTPUT.moments[0]!.note);
    expect(line).not.toContain((body.frames as { jpeg: string }[])[0]!.jpeg.slice(0, 40));
    expect(line).not.toContain(token);
    expect(line).not.toContain(token.split('.')[1]!);
    expect(Object.keys(entry).sort()).toEqual(
      ['attempts', 'bytes', 'code', 'frames', 'jti', 'ms', 'rid', 'route', 'status', 'ts'].sort(),
    );
  });

  it('모델 출력의 t 를 보낸 사진 시각으로 맞추고 목록에 없는 태그를 뺀다', async () => {
    const provider = fakeProvider([
      JSON.stringify({
        summary: '아이가 바닥에 앉아 자동차를 굴려요.',
        childStates: ['PLAYING_ALONE', 'DAYDREAMING'],
        adultResponses: ['HELPING'],
        moments: [{ t: 12.4, note: '아이가 자동차를 굴려요.' }],
        peopleCount: 5,
      }),
    ]);
    const { app } = testApp({ provider });
    const response = await app.handle(analyzeRequest({ body: { frames: [frame(0), frame(12.483), frame(25)] } }));
    expect(parse(response).observation).toEqual({
      summary: '아이가 바닥에 앉아 자동차를 굴려요.',
      childStates: ['PLAYING_ALONE'],
      adultResponses: [],
      moments: [{ t: 12.483, note: '아이가 자동차를 굴려요.' }],
      peopleCount: 3,
    });
  });
});

describe('분석 토큰', () => {
  async function codeFor(options: Parameters<typeof analyzeRequest>[0]): Promise<[number, unknown, number]> {
    const { app, provider } = testApp();
    const response = await app.handle(analyzeRequest(options));
    return [response.status, parse(response).code, provider.calls.length];
  }

  it('토큰이 없으면 401', async () => {
    expect(await codeFor({ token: null })).toEqual([401, 'INVALID_TOKEN', 0]);
    expect(await codeFor({ token: null, headers: { authorization: 'Basic abc' } })).toEqual([401, 'INVALID_TOKEN', 0]);
  });

  it('서명이 틀리면 401', async () => {
    expect(await codeFor({ token: sessionToken({}, OTHER_SECRET) })).toEqual([401, 'INVALID_TOKEN', 0]);
  });

  it('aud·iss 가 다르면 401', async () => {
    expect(await codeFor({ token: sessionToken({ aud: 'hamkke-api' }) })).toEqual([401, 'INVALID_TOKEN', 0]);
    expect(await codeFor({ token: sessionToken({ iss: 'hamkke-ai' }) })).toEqual([401, 'INVALID_TOKEN', 0]);
  });

  it('만료되었으면 401', async () => {
    expect(await codeFor({ token: sessionToken({ iat: NOW_SEC - 700, exp: NOW_SEC - 100 }) })).toEqual([401, 'INVALID_TOKEN', 0]);
  });

  it('alg none 토큰은 401', async () => {
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'none', typ: 'JWT' })}.${encode(sessionPayload())}.`;
    expect(await codeFor({ token: unsigned })).toEqual([401, 'INVALID_TOKEN', 0]);
  });

  it('필수 클레임이 빠지면 401', async () => {
    expect(await codeFor({ token: sessionToken({ cid: undefined }) })).toEqual([401, 'INVALID_TOKEN', 0]);
    expect(await codeFor({ token: sessionToken({ jti: undefined }) })).toEqual([401, 'INVALID_TOKEN', 0]);
  });

  it('토큰을 확인하기 전에는 본문을 읽지 않는다', async () => {
    const { app } = testApp();
    let consumed = 0;
    async function* body(): AsyncGenerator<Uint8Array> {
      consumed++;
      yield Buffer.from('{}');
    }
    const response = await app.handle({ ...analyzeRequest({ token: 'not.a.token' }), body: body() });
    expect(response.status).toBe(401);
    expect(consumed).toBe(0);
  });

  it('401 응답은 한국어 문장과 코드만 담는다', async () => {
    const { app, logs } = testApp();
    const response = await app.handle(analyzeRequest({ token: sessionToken({ aud: 'x' }) }));
    const body = parse(response);
    expect(Object.keys(body)).toEqual(['code', 'message']);
    expect(body.message).toMatch(/[가-힣]/);
    expect(logs[0]).toMatchObject({ status: 401, code: 'INVALID_TOKEN', detail: 'aud', jti: null });
  });
});

describe('사진 검사', () => {
  async function reject(body: unknown): Promise<[number, unknown, string | undefined]> {
    const { app, provider, logs } = testApp();
    const response = await app.handle(analyzeRequest({ body }));
    expect(provider.calls).toHaveLength(0);
    return [response.status, parse(response).code, logs[0]!.detail];
  }

  it('JPEG 가 아니면 400', async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
    expect(await reject({ frames: [frame(0), frame(5, png)] })).toEqual([400, 'INVALID_FRAMES', 'not_jpeg']);
  });

  it('한 장이 300KB 를 넘으면 400', async () => {
    const big = makeJpeg({ size: MAX_FRAME_BYTES + 1 });
    expect(await reject({ frames: [frame(0, big)] })).toEqual([400, 'INVALID_FRAMES', 'frame_too_large']);
  });

  it('6장을 넘거나 한 장도 없으면 400', async () => {
    expect(await reject(framesBody(7))).toEqual([400, 'INVALID_FRAMES', 'frame_count']);
    expect(await reject({ frames: [] })).toEqual([400, 'INVALID_FRAMES', 'frame_count']);
  });

  it('JSON 이 아니면 400', async () => {
    const { app } = testApp();
    const response = await app.handle(analyzeRequest({ rawBody: Buffer.from('frames=1') }));
    expect([response.status, parse(response).code]).toEqual([400, 'INVALID_FRAMES']);
  });

  it('6장까지는 받아들인다', async () => {
    const { app, provider } = testApp();
    const response = await app.handle(analyzeRequest({ body: framesBody(6) }));
    expect(response.status).toBe(200);
    expect(parse(response).analyzedFrames).toBe(6);
    expect(provider.calls[0]!.images).toHaveLength(6);
  });

  it('Content-Type 이 application/json 이 아니면 415', async () => {
    const { app } = testApp();
    const response = await app.handle(analyzeRequest({ headers: { 'content-type': 'text/plain' } }));
    expect([response.status, parse(response).code]).toEqual([415, 'UNSUPPORTED_MEDIA_TYPE']);
    const withCharset = await app.handle(analyzeRequest({ headers: { 'content-type': 'Application/JSON; charset=utf-8' } }));
    expect(withCharset.status).toBe(200);
  });

  it('거절된 요청의 토큰은 쓴 것으로 치지 않는다', async () => {
    const { app } = testApp();
    const token = sessionToken();
    expect((await app.handle(analyzeRequest({ token, body: framesBody(7) }))).status).toBe(400);
    expect((await app.handle(analyzeRequest({ token }))).status).toBe(200);
  });
});

describe('본문 크기', () => {
  it('Content-Length 가 2MB 를 넘으면 읽지 않고 413', async () => {
    const { app } = testApp();
    let consumed = 0;
    async function* body(): AsyncGenerator<Uint8Array> {
      consumed++;
      yield new Uint8Array(10);
    }
    const request = analyzeRequest({ headers: { 'content-length': String(MAX_BODY_BYTES + 1) } });
    const response = await app.handle({ ...request, body: body() });
    expect([response.status, parse(response).code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    expect(consumed).toBe(0);
  });

  it('길이를 알리지 않고 2MB 넘게 보내면 읽다가 멈추고 413', async () => {
    const { app, logs } = testApp();
    let sent = 0;
    async function* body(): AsyncGenerator<Uint8Array> {
      for (;;) {
        sent += 64 * 1024;
        yield new Uint8Array(64 * 1024).fill(0x20);
      }
    }
    const response = await app.handle({ ...analyzeRequest(), body: body() });
    expect([response.status, parse(response).code]).toEqual([413, 'PAYLOAD_TOO_LARGE']);
    expect(sent).toBe(MAX_BODY_BYTES + 64 * 1024);
    expect(logs[0]).toMatchObject({ status: 413, detail: 'body' });
  });

  it('Content-Length 를 작게 속여도 실제 크기로 막는다', async () => {
    const { app } = testApp();
    const request = analyzeRequest({ headers: { 'content-length': '10' } });
    const response = await app.handle({ ...request, body: chunked(new Uint8Array(MAX_BODY_BYTES + 1).fill(0x20)) });
    expect(response.status).toBe(413);
  });
});

describe('한 번만 쓰는 토큰', () => {
  it('같은 jti 를 다시 보내면 409', async () => {
    const { app, provider } = testApp();
    const token = sessionToken();
    expect((await app.handle(analyzeRequest({ token }))).status).toBe(200);
    const again = await app.handle(analyzeRequest({ token }));
    expect([again.status, parse(again).code]).toEqual([409, 'SESSION_ALREADY_USED']);
    expect(provider.calls).toHaveLength(1);
  });

  it('동시에 들어온 같은 jti 는 하나만 처리한다', async () => {
    const gate = deferred<string>();
    const provider = fakeProvider([() => gate.promise]);
    const { app } = testApp({ provider });
    const token = sessionToken();
    const first = app.handle(analyzeRequest({ token }));
    const second = app.handle(analyzeRequest({ token }));
    await tick();
    gate.resolve(GOOD);
    const statuses = [(await first).status, (await second).status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(provider.calls).toHaveLength(1);
  });

  it('모델이 실패한 요청의 토큰도 다시 쓸 수 없다', async () => {
    const provider = fakeProvider(['글', '글', GOOD]);
    const { app } = testApp({ provider });
    const token = sessionToken();
    expect((await app.handle(analyzeRequest({ token }))).status).toBe(502);
    expect((await app.handle(analyzeRequest({ token }))).status).toBe(409);
  });

  it('토큰이 만료된 뒤에는 기억에서 지워도 401 로 막힌다', async () => {
    const { app, clock } = testApp();
    const token = sessionToken();
    expect((await app.handle(analyzeRequest({ token }))).status).toBe(200);
    clock.ms += 601_000;
    expect((await app.handle(analyzeRequest({ token }))).status).toBe(401);
  });
});

describe('동시 처리 제한', () => {
  it('대기열이 넘치면 429 BUSY, 그 토큰은 나중에 다시 쓸 수 있다', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    let started = 0;
    const provider = fakeProvider([() => gates[started++]!.promise]);
    const { app } = testApp({ provider, config: { maxConcurrency: 1, maxWaiting: 1 } });

    const first = app.handle(analyzeRequest());
    const second = app.handle(analyzeRequest());
    await tick();
    expect(started).toBe(1);

    const overflowToken = sessionToken();
    const third = await app.handle(analyzeRequest({ token: overflowToken }));
    expect([third.status, parse(third).code]).toEqual([429, 'BUSY']);
    expect(third.headers['Retry-After']).toBe('10');

    gates[0]!.resolve(GOOD);
    expect((await first).status).toBe(200);
    await tick();
    expect(started).toBe(2);
    gates[1]!.resolve(GOOD);
    expect((await second).status).toBe(200);

    const retry = app.handle(analyzeRequest({ token: overflowToken }));
    await tick();
    gates[2]!.resolve(GOOD);
    expect((await retry).status).toBe(200);
  });

  it('동시 처리 수만큼만 모델을 부른다', async () => {
    const gate = deferred<string>();
    let running = 0;
    let peak = 0;
    const provider = fakeProvider([
      async () => {
        running++;
        peak = Math.max(peak, running);
        const text = await gate.promise;
        running--;
        return text;
      },
    ]);
    const { app } = testApp({ provider, config: { maxConcurrency: 2, maxWaiting: 4 } });
    const all = Array.from({ length: 5 }, () => app.handle(analyzeRequest()));
    await tick();
    expect(peak).toBe(2);
    gate.resolve(GOOD);
    expect((await Promise.all(all)).map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(peak).toBe(2);
  });

  it('기다리다 제한 시간이 지나면 429 로 알리고 토큰을 되돌린다', async () => {
    const queue: WorkQueue = {
      active: 1,
      waiting: 0,
      acquire: (signal) =>
        new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new QueueAbortedError()), { once: true })),
    };
    const { app, provider, logs } = testApp({ queue, config: { timeoutMs: 20 } });
    const token = sessionToken();
    const response = await app.handle(analyzeRequest({ token }));
    expect([response.status, parse(response).code]).toEqual([429, 'BUSY']);
    expect(logs[0]!.detail).toBe('wait_timeout');
    expect(provider.calls).toHaveLength(0);
    // 다시 보내면 409 가 아니라 같은 까닭(대기)으로 응답한다.
    expect((await app.handle(analyzeRequest({ token }))).status).toBe(429);
  });
});

describe('모델 제한 시간', () => {
  it('제한 시간을 넘기면 모델 호출을 중단하고 504', async () => {
    const provider = fakeProvider([untilAborted]);
    const { app, logs } = testApp({ provider, config: { timeoutMs: 30 } });
    const response = await app.handle(analyzeRequest());
    expect([response.status, parse(response).code]).toEqual([504, 'MODEL_TIMEOUT']);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.signal.aborted).toBe(true);
    expect(logs[0]).toMatchObject({ status: 504, code: 'MODEL_TIMEOUT', attempts: 1 });
  });

  it('신호를 따르지 않는 제공자여도 504 로 끝내고 자리를 내놓는다', async () => {
    const provider = fakeProvider([() => new Promise<string>(() => undefined), GOOD]);
    const { app } = testApp({ provider, config: { timeoutMs: 30 } });
    expect((await app.handle(analyzeRequest())).status).toBe(504);
    expect((await app.handle(analyzeRequest())).status).toBe(200);
  });

  it('제공자가 스스로 시간 초과를 알리면 다시 시도하지 않고 504', async () => {
    const provider = fakeProvider([new ProviderTimeoutError(), GOOD]);
    const { app } = testApp({ provider });
    const response = await app.handle(analyzeRequest());
    expect([response.status, parse(response).code]).toEqual([504, 'MODEL_TIMEOUT']);
    expect(provider.calls).toHaveLength(1);
  });
});

describe('모델 출력 검사와 다시 시도', () => {
  it('JSON 이 아니면 한 번 더 부르고, 그래도 안 되면 502', async () => {
    const provider = fakeProvider(['사진을 잘 봤어요!', '{"summary": "끝나지 않은']);
    const { app, logs } = testApp({ provider });
    const response = await app.handle(analyzeRequest());
    expect([response.status, parse(response).code]).toEqual([502, 'MODEL_UNAVAILABLE']);
    expect(provider.calls).toHaveLength(2);
    expect(parse(response).observation).toBeUndefined();
    expect(parse(response).receipt).toBeUndefined();
    expect(logs[0]).toMatchObject({ status: 502, attempts: 2, detail: 'bad_output' });
  });

  it('두 번째 출력이 쓸 만하면 200', async () => {
    const provider = fakeProvider(['{}', GOOD]);
    const { app, logs } = testApp({ provider });
    const response = await app.handle(analyzeRequest());
    expect(response.status).toBe(200);
    expect(provider.calls).toHaveLength(2);
    expect(logs[0]!.attempts).toBe(2);
  });

  it('검사에서 모두 버려지는 출력도 다시 시도하고, 그래도 안 되면 502', async () => {
    const filtered = JSON.stringify({
      summary: `아이에게 ${EVALUATIVE_TERMS[0]}가 있어 보여요.`,
      childStates: ['NAUGHTY'],
      adultResponses: [],
      moments: [],
      peopleCount: 2,
    });
    const provider = fakeProvider([filtered]);
    const { app } = testApp({ provider });
    const response = await app.handle(analyzeRequest());
    expect([response.status, parse(response).code]).toEqual([502, 'MODEL_UNAVAILABLE']);
    expect(provider.calls).toHaveLength(2);
    expect(response.body).not.toContain(EVALUATIVE_TERMS[0]!);
  });

  it('검사에 걸린 문장은 응답에도 영수증에도 들어가지 않는다', async () => {
    const provider = fakeProvider([
      JSON.stringify({ ...GOOD_OUTPUT, summary: `아이가 ${EVALUATIVE_TERMS[7]}해 보여요.`, moments: [] }),
    ]);
    const { app } = testApp({ provider });
    const response = await app.handle(analyzeRequest());
    expect(response.status).toBe(200);
    const body = parse(response);
    expect((body.observation as { summary: unknown }).summary).toBeNull();
    const claims = verifyJwt(body.receipt as string, SECRET);
    expect((claims.obs as { summary: unknown }).summary).toBeNull();
    expect(JSON.stringify(claims)).not.toContain(EVALUATIVE_TERMS[7]!);
  });

  it('모델 서버에 닿지 못하면 한 번 더 해 보고 502', async () => {
    const provider = fakeProvider([new ProviderUnavailableError('connect')]);
    const { app, logs } = testApp({ provider });
    const response = await app.handle(analyzeRequest());
    expect([response.status, parse(response).code]).toEqual([502, 'MODEL_UNAVAILABLE']);
    expect(provider.calls).toHaveLength(2);
    expect(logs[0]!.detail).toBe('connect');
  });

  it('한 번 끊겼다가 이어지면 200', async () => {
    const provider = fakeProvider([new ProviderUnavailableError('chat_http_500'), GOOD]);
    const { app } = testApp({ provider });
    expect((await app.handle(analyzeRequest())).status).toBe(200);
  });

  it('제공자가 낸 오류 문장은 응답과 로그에 옮기지 않는다', async () => {
    const provider = fakeProvider([new Error('raw model text: 아이 이름은 비밀')]);
    const { app, logs } = testApp({ provider });
    const response = await app.handle(analyzeRequest());
    expect(response.status).toBe(502);
    expect(response.body).not.toContain('비밀');
    expect(JSON.stringify(logs)).not.toContain('비밀');
    expect(logs[0]!.detail).toBe('provider_error');
  });
});

describe('연결이 끊긴 요청', () => {
  it('모델을 기다리는 중에 끊기면 호출을 중단하고 자리를 내놓는다', async () => {
    const provider = fakeProvider([untilAborted, GOOD]);
    const { app, logs } = testApp({ provider });
    const gone = new AbortController();
    const pending = app.handle(analyzeRequest({ signal: gone.signal }));
    await tick();
    gone.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(logs[0]).toMatchObject({ code: 'CLIENT_CLOSED' });
    expect(provider.calls[0]!.signal.aborted).toBe(true);
    expect((await app.handle(analyzeRequest())).status).toBe(200);
  });

  it('본문을 읽는 중에 끊기면 모델을 부르지 않는다', async () => {
    const { app, provider, logs } = testApp();
    async function* broken(): AsyncGenerator<Uint8Array> {
      yield Buffer.from('{"frames":[');
      throw new Error('aborted');
    }
    const response = await app.handle({ ...analyzeRequest(), body: broken() });
    expect(response.status).toBe(499);
    expect(logs[0]!.code).toBe('CLIENT_CLOSED');
    expect(provider.calls).toHaveLength(0);
  });
});

describe('GET /ai/v1/health', () => {
  it('모델 이름과 준비 여부를 알려 준다', async () => {
    const { app, logs } = testApp();
    const response = await app.handle(getRequest('/ai/v1/health'));
    expect(response.status).toBe(200);
    expect(parse(response)).toEqual({ status: 'ok', model: 'fake-vl:1', modelReady: true });
    expect(logs).toHaveLength(0);
  });

  it('모델 서버에 닿지 못하면 modelReady 가 false', async () => {
    const provider = fakeProvider();
    provider.ready = new Error('connect');
    const { app } = testApp({ provider });
    expect(parse(await app.handle(getRequest('/ai/v1/health')))).toEqual({ status: 'ok', model: 'fake-vl:1', modelReady: false });
    provider.ready = false;
    expect(parse(await app.handle(getRequest('/ai/v1/health?x=1'))).modelReady).toBe(false);
  });

  it('확인 결과를 몇 초 동안 기억한다', async () => {
    const { app, provider, clock } = testApp();
    await Promise.all([app.handle(getRequest('/ai/v1/health')), app.handle(getRequest('/ai/v1/health'))]);
    await app.handle(getRequest('/ai/v1/health'));
    expect(provider.readyChecks).toBe(1);
    clock.ms += 4_000;
    await app.handle(getRequest('/ai/v1/health'));
    expect(provider.readyChecks).toBe(1);
    clock.ms += 2_000;
    provider.ready = false;
    expect(parse(await app.handle(getRequest('/ai/v1/health'))).modelReady).toBe(false);
    expect(provider.readyChecks).toBe(2);
  });
});

describe('그 밖의 요청', () => {
  it('모르는 주소는 404 JSON', async () => {
    const { app, logs } = testApp();
    for (const url of ['/', '/ai/v1/analyze/extra', '/ai/v1/Health', '/api/v1/children']) {
      const response = await app.handle(getRequest(url));
      expect([response.status, parse(response).code], url).toEqual([404, 'NOT_FOUND']);
    }
    expect(logs).toHaveLength(4);
  });

  it('맞지 않는 방식은 405 JSON 과 Allow 헤더', async () => {
    const { app } = testApp();
    const get = await app.handle(getRequest('/ai/v1/analyze'));
    expect([get.status, parse(get).code, get.headers.Allow]).toEqual([405, 'METHOD_NOT_ALLOWED', 'POST']);
    const options = await app.handle(getRequest('/ai/v1/analyze', 'OPTIONS'));
    expect(options.status).toBe(405);
    expect(Object.keys(options.headers).some((name) => name.toLowerCase().startsWith('access-control-'))).toBe(false);
    const post = await app.handle(getRequest('/ai/v1/health', 'POST'));
    expect([post.status, post.headers.Allow]).toEqual([405, 'GET']);
  });

  it('모든 오류 응답은 code 와 한국어 message 를 갖는다', async () => {
    const { app } = testApp({ provider: fakeProvider(['글']) });
    const responses = [
      await app.handle(getRequest('/nope')),
      await app.handle(getRequest('/ai/v1/analyze')),
      await app.handle(analyzeRequest({ token: null })),
      await app.handle(analyzeRequest({ body: {} })),
      await app.handle(analyzeRequest()),
    ];
    for (const response of responses) {
      const body = parse(response);
      expect(Object.keys(body)).toEqual(['code', 'message']);
      expect(body.code).toMatch(/^[A-Z_]+$/);
      expect(body.message).toMatch(/[가-힣].*요\.$/);
    }
  });
});
