import { describe, expect, it, vi } from 'vitest';
import { createApp, DAYCARE_COACHING_PATH } from '../src/app.ts';
import { ConfigError, loadConfig } from '../src/config.ts';
import { createDaycareCoaching } from '../src/daycareCoaching.ts';
import { classroomActivities, classroomEvidence } from '../src/daycareActivities.ts';
import { createQueue } from '../src/queue.ts';
import { SECRET, analyzeRequest, deferred, fakeProvider } from './helpers.ts';

const origin = 'https://service.example.test';
const source = { code: 'CA-G-01', title: '편안한 시간이 늘었어요', body: '그림으로 다음 일과를 알려 주세요.' };
const input = { childId: 51, month: '2026-11' };

describe('어린이집 코칭 추천', () => {
  it('선택한 달의 카드로만 모델이 고르고, 근거 카드와 교실용 활동을 반환한다', async () => {
    const api = vi.fn<typeof fetch>().mockImplementation(async () => Response.json([{ ...source, childName: 'private-name' }]));
    const model = fakeProvider(['{"index":1}']);
    const log = vi.fn();
    const app = createApp({ config: { daycareApiOrigin: origin, secret: SECRET, maxConcurrency: 1, maxWaiting: 2, timeoutMs: 5000 }, provider: model, coachingFetch: api, log });
    const result = await app.handle(analyzeRequest({ url: DAYCARE_COACHING_PATH, token: 'teacher.secret.token', body: input }));
    expect(result.status).toBe(200);
    expect(result.headers['Cache-Control']).toBe('no-store');
    expect(JSON.parse(result.body).recommendation).toMatchObject({
      sourceCode: source.code, sourceTitle: source.title, title: '교실을 옮기기 전에 미리 알리기', action: expect.stringContaining('바깥놀이'),
      evidence: { reason: expect.stringContaining('그림'), sourceId: 'dfe-interactions-visual', sourceTitle: 'Interactions',
        sourcePublisher: '영국 교육부(DfE)', sourceSection: expect.stringContaining('사물과 그림'),
        sourceUrl: 'https://help-for-early-years-providers.education.gov.uk/areas-of-learning/communication-and-language/interactions' },
    });
    expect(api.mock.calls).toHaveLength(2);
    for (const [url, options] of api.mock.calls) {
      expect(String(url)).toBe(origin + '/api/v1/teacher/children/51/daycare-coaching/cards?month=2026-11');
      expect(options).toMatchObject({ headers: { Authorization: 'Bearer teacher.secret.token' }, redirect: 'error', cache: 'no-store' });
    }
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.images).toEqual([]);
    expect(JSON.parse(model.calls[0]!.user).cards).toEqual([source]);
    for (const secret of ['teacher.secret.token', 'private-name', '"childId"', '"month"']) {
      expect(model.calls[0]!.user).not.toContain(secret);
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    }
  });

  it('모든 교실 활동의 출처 문단을 내려받은 자료에서 확인하고, 활동별 이유를 연결한다', () => {
    for (const activity of classroomActivities) {
      expect(classroomEvidence(activity), activity.title).toMatchObject({
        reason: activity.reason, sourceTitle: expect.any(String), sourcePublisher: expect.any(String),
        sourceSection: expect.any(String), sourceUrl: expect.stringMatching(/^https:\/\//),
      });
    }
    const recording = classroomActivities.find(activity => activity.reference === 'observation')!;
    expect(classroomEvidence(recording)?.sourceUrl).toMatch(/#page=4$/);
  });

  it('같은 코칭은 추론을 공유하고 모든 교사의 현재 공유 권한은 각각 확인한다', async () => {
    const chosen = deferred<string>();
    const started = deferred<void>();
    const model = fakeProvider([() => { started.resolve(); return chosen.promise; }]);
    const api = vi.fn<typeof fetch>().mockImplementation(async () => Response.json([source]));
    const run = createDaycareCoaching(origin, model, createQueue(1, 1), api);
    const a = run('a', input);
    await started.promise;
    const b = run('b', { ...input, childId: 52 });
    chosen.resolve('{"index":0}');
    expect(await a).toEqual(await b);
    expect(await run('c', input)).toEqual(await a);
    expect(api).toHaveBeenCalledTimes(6);
    expect(model.calls).toHaveLength(1);
    api.mockImplementationOnce(async () => new Response(null, { status: 404 }));
    await expect(run('revoked', input)).rejects.toMatchObject({ status: 404, code: 'COACHING_NOT_SHARED' });
  });

  it.each([401, 403, 404])('생성 도중 권한이 사라지면 결과를 반환하지 않는다 (%i)', async status => {
    const api = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([source])).mockResolvedValueOnce(new Response(null, { status }));
    const run = createDaycareCoaching(origin, fakeProvider(['{"index":0}']), createQueue(1, 1), api);
    await expect(run('t', input)).rejects.toMatchObject({ status });
  });

  it('카드 본문·목록이 바뀌면 결과를 폐기한다', async () => {
    const api = vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json([source])).mockResolvedValueOnce(Response.json([{ ...source, body: '다른 내용' }]));
    const run = createDaycareCoaching(origin, fakeProvider(['{"index":0}']), createQueue(1, 1), api);
    await expect(run('t', input)).rejects.toMatchObject({ status: 409 });
  });

  it('공유 카드가 없을 때는 모델을 부르지 않는다', async () => {
    const model = fakeProvider();
    const run = createDaycareCoaching(origin, model, createQueue(1, 1), async () => Response.json([]));
    expect(await run('t', input)).toBeNull();
    expect(model.calls).toHaveLength(0);
  });

  it('모델의 잘못된 출력에 추천을 붙이지 않고 다음 요청에서 다시 시도한다', async () => {
    const model = fakeProvider(['{"index":99}', '{"index":0}']);
    const run = createDaycareCoaching(origin, model, createQueue(1, 1), async () => Response.json([source]));
    await expect(run('t', input)).rejects.toMatchObject({ status: 503 });
    expect(await run('t', input)).toMatchObject({ sourceCode: source.code });
  });

  it('영상 추론이 진행 중이면 대기열을 차지하지 않는다', async () => {
    const queue = createQueue(1, 1);
    const release = await queue.acquire();
    const model = fakeProvider();
    const run = createDaycareCoaching(origin, model, queue, async () => Response.json([source]));
    await expect(run('t', input)).rejects.toMatchObject({ status: 429 });
    expect(queue.waiting).toBe(0);
    expect(model.calls).toHaveLength(0);
    release();
  });

  it('주소, 사진, 본문을 보내거나 로그인하지 않은 요청은 API를 호출하기 전에 거절한다', async () => {
    const api = vi.fn<typeof fetch>();
    const app = createApp({ config: { daycareApiOrigin: origin, secret: SECRET, maxConcurrency: 1, maxWaiting: 2, timeoutMs: 5000 }, provider: fakeProvider(), coachingFetch: api, log: vi.fn() });
    for (const body of [{ ...input, url: 'https://unexpected.invalid' }, { ...input, month: '2026-13' }, { childId: '../x', month: input.month }]) {
      const result = await app.handle(analyzeRequest({ url: DAYCARE_COACHING_PATH, token: 'token', body }));
      expect(result.status).toBe(400);
    }
    expect((await app.handle(analyzeRequest({ url: DAYCARE_COACHING_PATH, token: null, body: input }))).status).toBe(401);
    expect(api).not.toHaveBeenCalled();
  });

  it('허용한 출처에만 인증을 보내며 외부 평문 주소는 설정하지 못한다', () => {
    expect(loadConfig({}).daycareApiOrigin).toBeNull();
    for (const url of [origin, 'http://127.0.0.1:18980']) expect(loadConfig({ DAYCARE_API_ORIGIN: url }).daycareApiOrigin).toBe(url);
    for (const url of ['http://example.test', origin + '/proxy', 'https://user:pw@example.test', origin + '?u=https://elsewhere.invalid']) {
      expect(() => loadConfig({ DAYCARE_API_ORIGIN: url })).toThrowError(ConfigError);
    }
  });
});
