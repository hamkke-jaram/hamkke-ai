import { describe, expect, it, vi } from 'vitest';
import { createApp, TEACHER_STORY_DRAFT_PATH } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createLocalDraftProvider } from '../src/providers.ts';
import { createQueue } from '../src/queue.ts';
import { createTeacherStoryDraft } from '../src/teacherStoryDraft.ts';
import { analyzeRequest, fakeProvider, SECRET } from './helpers.ts';

const origin = 'https://service.example.test';
const input = { childId: 75, memo: '아이가 혼자 노란 컵을 선반에 올려놓음.' };
const answer = { title: '선반에 놓은 노란 컵', content: '아이가 혼자 노란 컵을 선반에 올려놓았어요.' };
const generated = JSON.stringify({ observed: true, ...answer });
const passed = '{"faithful":true}';
const allowed = () => new Response(null, { status: 200, headers: { 'content-type': 'application/json' } });
const api = () => vi.fn<typeof fetch>().mockImplementation(async () => allowed());
const config = { daycareApiOrigin:origin, secret:SECRET, maxConcurrency:1, maxWaiting:1, timeoutMs:5000 };
const request = (body:unknown = input, token:string|null = 'teacher-only') => analyzeRequest({ url:TEACHER_STORY_DRAFT_PATH, body, token });

describe('교사 이야기 초안', () => {
  it('작성과 검토는 로컬 모델에서 진행하고 교사 연결은 결과 전에도 확인한다', async () => {
    const access = api(), model = fakeProvider([generated, passed]), general = fakeProvider(), log = vi.fn();
    const app = createApp({ config, provider:general, draftModel:model, coachingFetch:access, log });
    const res = await app.handle(request());
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual(answer);
    expect(res.headers['Cache-Control']).toBe('no-store');
    expect(access.mock.calls).toHaveLength(2);
    for (const [url, options] of access.mock.calls) {
      expect(String(url)).toBe(origin + '/api/v1/teacher/children/75/shared-summary?weeks=1');
      expect(options).toMatchObject({ method:'HEAD', redirect:'error', cache:'no-store', headers:{ Authorization:'Bearer teacher-only' } });
      expect(options?.body).toBeUndefined();
    }
    expect(general.calls).toHaveLength(0);
    expect(model.calls).toHaveLength(2);
    expect(JSON.parse(model.calls[0]!.user)).toEqual({ memo:input.memo });
    expect(JSON.parse(model.calls[1]!.user)).toEqual({ memo:input.memo, draft:answer });
    const logs = JSON.stringify(log.mock.calls);
    for (const privateValue of [input.memo, answer.content, 'teacher-only']) expect(logs).not.toContain(privateValue);
  });

  it('비어 있는 메모, 잘못된 아이, 다른 필드, 크기 초과 또는 로그인 누락은 보내지 않는다', async () => {
    const access = api(), model = fakeProvider();
    const app = createApp({ config, provider:model, draftModel:model, coachingFetch:access, log:vi.fn() });
    for (const body of [{ ...input,memo:'　' },{ ...input,memo:'가'.repeat(1001) },{ ...input,childId:0 },{ ...input,image:'x' }])
      expect((await app.handle(request(body))).status).toBe(400);
    expect((await app.handle(request({ ...input,memo:'가'.repeat(4000) }))).status).toBe(413);
    expect((await app.handle(request(input,null))).status).toBe(401);
    expect(access).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(0);
  });

  it('연결 없는 계정과 도중에 연결이 해제된 계정에는 결과를 전달하지 않는다', async () => {
    const access = api(), model = fakeProvider([generated, passed]);
    const draft = createTeacherStoryDraft(origin, model, createQueue(1,1), access);
    access.mockResolvedValueOnce(new Response(null, {status:404}));
    await expect(draft('token',input)).rejects.toMatchObject({ status:404 });
    expect(model.calls).toHaveLength(0);
    access.mockResolvedValueOnce(allowed()).mockResolvedValueOnce(new Response(null, {status:404}));
    await expect(draft('token',input)).rejects.toMatchObject({ status:404 });
    access.mockResolvedValueOnce(new Response(null, {headers:{'content-type':'text/html'}}));
    await expect(draft('token',input)).rejects.toMatchObject({ status:503 });
    expect(model.calls).toHaveLength(2);
  });

  it('자료와 맞지 않는 생성 결과는 한 번 다시 작성하고 재검토한다', async () => {
    const model = fakeProvider([JSON.stringify({ ...answer, observed:true, content:'친구와 컵을 옮겼어요.' }), '{"faithful":false}', generated, passed]);
    const draft = createTeacherStoryDraft(origin, model, createQueue(1,1), api());
    await expect(draft('token',input)).resolves.toEqual(answer);
    expect(model.calls).toHaveLength(4);
  });

  it.each([
    { ...answer, title:'“선반”이라고 말한 아이' },
    { ...answer, content:"아이가 '같이 놀자'라고 말했어요." },
    { ...answer, content:'아이가 컵을 3번 옮겼어요.' },
    { ...answer, title:'컵을 옮기지 못한 아이' },
    { ...answer, content:'아이가 혼자 컵을 옮김.' },
    { ...answer, title:'가'.repeat(41) },
    { ...answer, content:'가'.repeat(1000)+'요' },
  ])('근거가 없는 인용·수량과 어미·길이 규칙을 검사한다', async bad => {
    const model = fakeProvider([JSON.stringify({ observed:true, ...bad })]);
    await expect(createTeacherStoryDraft(origin,model,createQueue(1,1),api())('token',input)).rejects.toMatchObject({status:422});
  });

  it('구체적인 관찰이 없는 메모는 예시로 채우지 않는다', async () => {
    const model = fakeProvider(['{"observed":false,"title":"","content":""}']);
    await expect(createTeacherStoryDraft(origin,model,createQueue(1,1),api())('token',input)).rejects.toMatchObject({status:422, code:'DRAFT_NEEDS_OBSERVATION'});
  });
  it('로컬 모델이 없거나 영상 처리 중일 때 다른 모델을 이용하지 않는다', async () => {
    const queue = createQueue(1,1), access = api(), model=fakeProvider();
    await expect(createTeacherStoryDraft(origin,null,queue,access)('token',input)).rejects.toMatchObject({status:503});
    const release = await queue.acquire();
    try { await expect(createTeacherStoryDraft(origin,model,queue,access)('token',input)).rejects.toMatchObject({status:429}); }
    finally { release(); }
    expect(model.calls).toHaveLength(0);
  });
  it('외부 모델 주소나 클라우드 모델로 메모를 전달하지 않는다', async () => {
    const opts=loadConfig({});
    expect(createLocalDraftProvider({...opts,ollamaUrl:'https://example.test'})).toBeNull();
    expect(createLocalDraftProvider({...opts,model:'text:cloud'})).toBeNull();
    const adapter = vi.fn<typeof fetch>().mockResolvedValue(Response.json({remote_host:'https://example.test',model_info:{weights:'x'}}));
    const model=createLocalDraftProvider(opts,adapter)!;
    await expect(createTeacherStoryDraft(origin,model,createQueue(1,1),api())('token',input)).rejects.toMatchObject({status:503});
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(adapter.mock.calls[0]![1]?.redirect).toBe('error');
    expect(adapter.mock.calls[0]![1]?.body).not.toContain(input.memo);
  });
});
