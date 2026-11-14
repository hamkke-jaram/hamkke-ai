// 건강 확인 ?strict=1, 지표(GET /ai/v1/metrics), 대신 쓰는 모델이 영수증에 남는지.
import { describe, expect, it } from 'vitest';
import type { AppRequest } from '../src/app.ts';
import { verifyJwt } from '../src/jwt.ts';
import { LATENCY_BUCKETS_SEC, createMetrics, labelValue } from '../src/metrics.ts';
import { ProviderUnavailableError } from '../src/provider.ts';
import {
  GOOD_OUTPUT,
  SECRET,
  analyzeRequest,
  chunked,
  fakeProvider,
  framesBody,
  getRequest,
  parse,
  sessionToken,
  testApp,
} from './helpers.ts';

const METRICS_TOKEN = 'metrics-token-0123456789abcdef';

function metricsRequest(authorization?: string, method = 'GET'): AppRequest {
  const headers: Record<string, string> = {};
  if (authorization !== undefined) headers.authorization = authorization;
  return { method, url: '/ai/v1/metrics', headers, body: chunked(new Uint8Array(0)) };
}

/** Prometheus 글에서 이름{라벨} 값 한 줄의 값을 꺼낸다. */
function sample(text: string, series: string): number | undefined {
  const line = text.split('\n').find((l) => l.startsWith(`${series} `));
  return line === undefined ? undefined : Number(line.slice(series.length + 1));
}

describe('GET /ai/v1/health?strict=1', () => {
  it('모델을 쓸 수 있으면 200, 기본 응답과 같다', async () => {
    const { app } = testApp();
    const response = await app.handle(getRequest('/ai/v1/health?strict=1'));
    expect(response.status).toBe(200);
    expect(parse(response)).toEqual({ status: 'ok', model: 'fake-vl:1', modelReady: true });
  });

  it('모델을 쓸 수 없으면 503 과 Retry-After, strict 가 없으면 그대로 200', async () => {
    const provider = fakeProvider();
    provider.ready = false;
    const { app, logs } = testApp({ provider });
    const strict = await app.handle(getRequest('/ai/v1/health?strict=1'));
    expect(strict.status).toBe(503);
    expect(parse(strict)).toEqual({ status: 'unavailable', model: 'fake-vl:1', modelReady: false });
    expect(strict.headers['Retry-After']).toBe('10');
    expect(strict.headers['Cache-Control']).toBe('no-store');
    expect((await app.handle(getRequest('/ai/v1/health?strict=true'))).status).toBe(503);

    const loose = await app.handle(getRequest('/ai/v1/health'));
    expect(loose.status).toBe(200);
    expect((await app.handle(getRequest('/ai/v1/health?strict=0'))).status).toBe(200);
    // 503 건강 확인은 로그에 남는다(가동 감시가 알아챌 수 있게), 200 은 남지 않는다.
    expect(logs.map((l) => [l.route, l.status, l.code])).toEqual([
      ['health', 503, 'MODEL_NOT_READY'],
      ['health', 503, 'MODEL_NOT_READY'],
    ]);
  });

  it('대신 쓰는 모델이 있으면 그 이름도 알려 준다', async () => {
    const provider = Object.assign(fakeProvider(), { fallbackModelVersion: 'small-vl:1' });
    const { app } = testApp({ provider });
    expect(parse(await app.handle(getRequest('/ai/v1/health')))).toEqual({
      status: 'ok',
      model: 'fake-vl:1',
      modelReady: true,
      fallbackModel: 'small-vl:1',
    });
  });
});

describe('GET /ai/v1/metrics', () => {
  it('요청 수·걸린 시간·대기열·모델 준비 상태를 Prometheus 글로 돌려준다', async () => {
    const { app, clock, logs } = testApp();
    await app.handle(analyzeRequest());
    await app.handle(analyzeRequest({ token: null }));
    clock.ms += 1;
    const response = await app.handle(metricsRequest());
    expect(response.status).toBe(200);
    expect(response.headers['Content-Type']).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(response.headers['Cache-Control']).toBe('no-store');
    const text = response.body;
    expect(sample(text, 'hamkke_ai_requests_total{route="analyze",status="200",code="OK"}')).toBe(1);
    expect(sample(text, 'hamkke_ai_requests_total{route="analyze",status="401",code="INVALID_TOKEN"}')).toBe(1);
    expect(sample(text, 'hamkke_ai_request_duration_seconds_count{route="analyze"}')).toBe(2);
    expect(sample(text, 'hamkke_ai_request_duration_seconds_bucket{route="analyze",le="+Inf"}')).toBe(2);
    expect(sample(text, 'hamkke_ai_model_calls_total{result="ok"}')).toBe(1);
    expect(sample(text, 'hamkke_ai_observations_total{model="fake-vl:1",fallback="false"}')).toBe(1);
    expect(sample(text, 'hamkke_ai_queue_active')).toBe(0);
    expect(sample(text, 'hamkke_ai_queue_waiting')).toBe(0);
    expect(sample(text, 'hamkke_ai_queue_max_concurrency')).toBe(1);
    expect(sample(text, 'hamkke_ai_queue_max_waiting')).toBe(2);
    expect(sample(text, 'hamkke_ai_model_ready')).toBe(1);
    expect(sample(text, 'hamkke_ai_used_sessions')).toBe(1);
    expect(text).toContain('hamkke_ai_info{model="fake-vl:1",prompt_version="obs-v1"} 1');
    expect(text).toContain('# TYPE hamkke_ai_request_duration_seconds histogram');
    // 성공한 지표 수집은 로그에 남지 않는다.
    expect(logs.map((l) => l.route)).toEqual(['analyze', 'analyze']);
  });

  it('지표에는 사진·문장·토큰·jti 가 없다', async () => {
    const { app } = testApp();
    const token = sessionToken();
    const body = framesBody(2);
    await app.handle(analyzeRequest({ token, body }));
    const text = (await app.handle(metricsRequest())).body;
    expect(text).not.toContain(GOOD_OUTPUT.summary);
    expect(text).not.toContain(GOOD_OUTPUT.moments[0]!.note);
    expect(text).not.toContain(token.split('.')[1]!);
    expect(text).not.toContain((body.frames as { jpeg: string }[])[0]!.jpeg.slice(0, 40));
    expect(text).not.toMatch(/jti|rid=|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('METRICS_TOKEN 을 정하면 Bearer 토큰이 있어야 한다', async () => {
    const { app, logs } = testApp({ config: { metricsToken: METRICS_TOKEN } });
    for (const authorization of [undefined, 'Bearer wrong-token-0123456789', `Basic ${METRICS_TOKEN}`, `Bearer ${METRICS_TOKEN}x`]) {
      const response = await app.handle(metricsRequest(authorization));
      expect([response.status, parse(response).code], String(authorization)).toEqual([401, 'UNAUTHORIZED']);
      expect(response.headers['WWW-Authenticate']).toBe('Bearer');
    }
    const ok = await app.handle(metricsRequest(`Bearer ${METRICS_TOKEN}`));
    expect(ok.status).toBe(200);
    expect(ok.body).toContain('hamkke_ai_requests_total{route="metrics",status="401",code="UNAUTHORIZED"} 4');
    // 거절된 수집은 로그에 남고, 토큰 값은 남지 않는다.
    expect(logs).toHaveLength(4);
    expect(JSON.stringify(logs)).not.toContain(METRICS_TOKEN);
  });

  it('GET 이 아니면 405', async () => {
    const { app } = testApp();
    const response = await app.handle(metricsRequest(undefined, 'POST'));
    expect([response.status, response.headers.Allow]).toEqual([405, 'GET']);
  });
});

describe('지표 계산', () => {
  it('걸린 시간을 구간마다 누적해서 센다', () => {
    const metrics = createMetrics(0);
    metrics.recordRequest('analyze', 200, 'OK', 30);
    metrics.recordRequest('analyze', 200, 'OK', 25_000);
    metrics.recordRequest('analyze', 504, 'MODEL_TIMEOUT', 400_000);
    const text = metrics.render(
      { queueActive: 1, queueWaiting: 2, maxConcurrency: 1, maxWaiting: 2, modelReady: false, jtiStored: 0 },
      { model: 'm', fallbackModel: 'f', promptVersion: 'obs-v1' },
    );
    expect(sample(text, 'hamkke_ai_request_duration_seconds_bucket{route="analyze",le="0.05"}')).toBe(1);
    expect(sample(text, 'hamkke_ai_request_duration_seconds_bucket{route="analyze",le="30"}')).toBe(2);
    expect(sample(text, 'hamkke_ai_request_duration_seconds_bucket{route="analyze",le="300"}')).toBe(2);
    expect(sample(text, 'hamkke_ai_request_duration_seconds_bucket{route="analyze",le="+Inf"}')).toBe(3);
    expect(sample(text, 'hamkke_ai_request_duration_seconds_sum{route="analyze"}')).toBeCloseTo(425.03, 5);
    expect(sample(text, 'hamkke_ai_model_ready')).toBe(0);
    expect(text).toContain('hamkke_ai_info{model="m",fallback_model="f",prompt_version="obs-v1"} 1');
    expect(text.split('\n').filter((l) => l.includes('_bucket{route="analyze"'))).toHaveLength(LATENCY_BUCKETS_SEC.length + 1);
  });

  it('라벨 값을 이스케이프하고, 모르는 모양의 코드는 other 로 센다', () => {
    expect(labelValue('a"b\\c\nd')).toBe('a\\"b\\\\c\\nd');
    const metrics = createMetrics(0);
    metrics.recordRequest('other', 404, 'bad code"} 1\nx', 1);
    const text = metrics.render(
      { queueActive: 0, queueWaiting: 0, maxConcurrency: 1, maxWaiting: 0, modelReady: true, jtiStored: 0 },
      { model: 'm', fallbackModel: null, promptVersion: 'obs-v1' },
    );
    expect(text).toContain('hamkke_ai_requests_total{route="other",status="404",code="other"} 1');
  });
});

describe('대신 쓰는 모델의 이름이 영수증에 남는다', () => {
  it('제공자가 다른 모델 이름을 돌려주면 응답 modelVersion 과 영수증 mv 가 그 이름이다', async () => {
    const provider = fakeProvider([async () => JSON.stringify(GOOD_OUTPUT)]);
    const generate = provider.generate.bind(provider);
    provider.generate = async (request) => ({ text: (await generate(request)) as string, modelVersion: 'small-vl:1' });
    const { app, logs } = testApp({ provider });
    const response = await app.handle(analyzeRequest());
    expect(response.status).toBe(200);
    const body = parse(response);
    expect(body.modelVersion).toBe('small-vl:1');
    expect(verifyJwt(body.receipt as string, SECRET).mv).toBe('small-vl:1');
    expect(logs[0]).toMatchObject({ status: 200, fallback: true });
    const text = (await app.handle(metricsRequest())).body;
    expect(sample(text, 'hamkke_ai_observations_total{model="small-vl:1",fallback="true"}')).toBe(1);
  });

  it('모델 호출 결과(쓸 수 없는 출력, 연결 실패)를 센다', async () => {
    const provider = fakeProvider([new ProviderUnavailableError('connect'), '글']);
    const { app } = testApp({ provider });
    expect((await app.handle(analyzeRequest())).status).toBe(502);
    const text = (await app.handle(metricsRequest())).body;
    expect(sample(text, 'hamkke_ai_model_calls_total{result="unavailable"}')).toBe(1);
    expect(sample(text, 'hamkke_ai_model_calls_total{result="bad_output"}')).toBe(1);
    expect(sample(text, 'hamkke_ai_requests_total{route="analyze",status="502",code="MODEL_UNAVAILABLE"}')).toBe(1);
  });
});
