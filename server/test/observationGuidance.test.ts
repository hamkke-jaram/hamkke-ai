import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { populateEvidence } from '../evidence/build.mjs';
import { describe, expect, it, vi } from 'vitest';
import { createApp, OBSERVATION_GUIDANCE_PATH } from '../src/app.ts';
import { CORPUS_VERSION, findEvidence, groundRecommendations } from '../src/observationEvidence.ts';
import { verifyJwt } from '../src/jwt.ts';
import type { VisionRequest } from '../src/provider.ts';
import { analyzeRequest, fakeProvider, SECRET } from './helpers.ts';

const scene = '아이가 혼자 빨간 블록을 쌓아요.';
const pointing = '아이가 손가락으로 책을 가리켜요.';
const context = {
  reviewerId:9, ageMonths:45, status:'PENDING',
  observation:{ id:3, source:'HOME', peopleCount:1, summary:scene, moments:[{ t:2, note:pointing }] },
};
const display = {
  observationId:3, recordedAt:'2026-11-19T03:00:00Z', source:'HOME', peopleCount:1, summary:scene,
  scenes:context.observation.moments, child:{ notes:context.observation.moments, tags:['FOCUSED'] },
  caregiver:{ notes:[], tags:[], role:'ADULT' },
  relatedCoaching:{ deliveryId:8, title:'놀이 지켜보기', href:'/t/children/1/coaching/8' },
  actions:[
    { type:'WRITE_PARENT_FEEDBACK', label:'보호자에게 피드백 쓰기', href:'/t/children/1/story/new' },
    { type:'REQUEST_CONSULTATION', label:'상담 요청하기', href:'/t/children/1/talk?draft=consultation' },
  ],
};
const ok = (value: unknown = context) => new Response(JSON.stringify(value), {headers:{'content-type':'application/json'}});
function makeApp(fetchApi = vi.fn<typeof fetch>().mockResolvedValue(ok()), selected = '{"indexes":[0]}') {
  const config = {secret:SECRET,daycareApiOrigin:'https://api.example.test',timeoutMs:60000,maxConcurrency:1,maxWaiting:1};
  const generate = vi.fn(async (_request: VisionRequest) => selected);
  const model = { ...fakeProvider(), generate };
  const log = vi.fn();
  const app = createApp({config,provider:fakeProvider(),draftModel:model,coachingFetch:fetchApi,log});
  const request = (body = {}, token: string | null = 'teacher-test') => app.handle(analyzeRequest({
    url:OBSERVATION_GUIDANCE_PATH, token, body:{childId:1,observationId:3,...body},
  }));
  return {request,generate,log,fetchApi};
}
describe('공개 자료 검색과 교사 검토용 추천', () => {
  it('내려받은 원문에서 재구성한 근거·출처·검색 색인이 배포된 DB와 일치한다', () => {
    const disk = new DatabaseSync(new URL('../evidence/care-2026-11-20-v2.sqlite',import.meta.url),{readOnly:true});
    const built = new DatabaseSync(':memory:');
    try {
      populateEvidence(built);
      for (const table of ['metadata','source_document','passage_provenance','passage','evidence_search']) {
        const read = (db: DatabaseSync) => createHash('sha256').update(JSON.stringify(db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all())).digest('hex');
        expect(read(built)).toBe(read(disk));
      }
      expect(disk.prepare('SELECT count(*) AS n FROM passage_provenance').get()!.n).toBeGreaterThan(7);
      expect(() => disk.exec("INSERT INTO metadata VALUES ('test')")).toThrow();
    } finally { disk.close(); built.close(); }
  });
  it('연령과 긍정적인 아이 행동 단서로 찾고 모호한 주체와 부정된 행위는 보류한다', () => {
    expect(findEvidence([scene],48).some(c=>['explore','build'].includes(c.passage.topic))).toBe(true);
    const younger = findEvidence([scene],18);
    expect(younger.some(c=>c.passage.id==='NURI-OBSERVE-PLAY' || c.passage.id==='CDC-PLAY-DESCRIBE')).toBe(false);
    expect(findEvidence([scene],null)).toEqual([]);
    expect(findEvidence([pointing],null).map(c=>c.passage.topic)).toContain('gesture');
    expect(findEvidence(['아이가 울음을 멈추고 블록을 쌓아요.'],40).map(c=>c.passage.id)).not.toContain('CDC-TIME-IN');
    for (const text of ['어른이 블록을 쌓고 아이는 바닥에 앉아 있어요.','아이가 블록을 쌓지 않았어요.',
      '아이가 차를 굴리는 것 같아요.','사람이 파란 블록을 쌓아요.','아이는 화면에 보이지 않아요.','아이가 블록 옆에 서 있어요.']) {
      expect(findEvidence([text],48)).toEqual([]);
    }
  });
  it.each([
    '아이가 울면서 어른에게 손을 뻗어요.',
    '아이가 울며 어른을 봐요.',
    '아이가 울지만 어른이 옆에 앉아요.',
    '아이가 눈을 비비며 흐느껴요.',
    '아이가 바닥에 앉아 울고 있어요.',
    '아이가 어른이랑 걷다가 울어요.',
    '아이가 울고 있는 모습이 보여요.',
    '아기가 얼굴을 찡그리며 울음을 터뜨려요.',
    '아이가 웃지 않고 울고 있어요.',
  ])('아이의 울음 동작을 어미와 관계없이 근거에 연결한다 (%s)', text => {
    const findCrying = (age: number) => findEvidence([text], age).some(c => c.passage.id === 'CDC-TIME-IN');
    expect(findCrying(36)).toBe(true);
    expect(findCrying(23)).toBe(false);
    expect(findCrying(60)).toBe(false);
  });
  it.each([
    '어른이 울고 아이는 옆에 앉아요.',
    '아이는 울고 있는 어른을 봐요.',
    '울며 다가온 어른 옆에 아이가 앉아요.',
    '아이가 울고 있는 인형을 안아요.',
    '아이가 밖에서 들리는 울음에 고개를 돌려요.',
    '아이가 울고 있는 척해요.',
    '아이가 울고 있다는 화면 자막이 나와요.',
    '휴대폰에서 우는 아이가 나와요.',
    '아이가 울지 않아요.',
    '아이가 울음을 그치고 블록을 쌓아요.',
  ])('관찰 대상의 직접적인 울음이 없으면 울음 자료를 고르지 않는다 (%s)', text => {
    expect(findEvidence([text], 36).some(c => c.passage.id === 'CDC-TIME-IN')).toBe(false);
  });
  const scenarios = [
    ['아이가 빨간 크레용으로 종이에 동그라미를 그려요.', 42, 'draw'],
    ['아이가 인형에게 작은 숟가락으로 밥을 먹이는 시늉을 내요.', 40, 'pretend'],
    ['아이가 플라스틱 조각을 모양별로 나눠 놓아요.', 40, 'sort'],
    ['아이가 놀이를 마치고 장난감을 정리함에 넣어요.', 27, 'cleanup'],
    ['아이가 두 가지 놀잇감 중에서 작은 북을 골라요.', 29, 'choose'],
    ['아이가 몸을 흔들며 탬버린을 흔들어요.', 39, 'music'],
    ['아이가 손가락으로 블록을 하나씩 짚으며 개수를 세요.', 50, 'count'],
    ['아이가 잎 위의 개미를 가까이에서 살펴봐요.', 40, 'nature'],
    ['아이가 자기 외투의 지퍼를 올려요.', 64, 'dress'],
    ['아이가 친구랑 함께 나무 블록으로 높은 탑을 쌓아요.', 30, 'peer'],
    ['아이가 바구니에 고리를 하나씩 담아요.', 15, 'container'],
    ['아이가 방석 밑에 숨긴 장난감을 찾아요.', 10, 'hide'],
    ['아이가 색칠하지 않고 퍼즐 조각을 자리에 맞춰요.', 37, 'puzzle'],
    ['아이가 자기가 만든 그림을 선생님에게 들어 보여줘요.', 40, 'show'],
    ['아이가 내민 장난감을 밀어내며 고개를 가로저어요.', 40, 'refuse'],
    ['아이가 두 발을 붙이고 제자리에서 폴짝 뛰어요.', 42, 'move'],
    ['아이가 빨간색 조각과 노란색 조각을 번갈아 줄지어 놓아요.', 48, 'pattern'],
    ['아이가 장난감 냄비로 요리하는 흉내를 내요.', 32, 'pretend-cook'],
    ['아이가 음악에 맞춰 춤을 춰요.', 52, 'dance'],
    ['아이가 짧은 박자를 반복하며 손뼉을 쳐요.', 42, 'rhythm'],
    ['아이가 발로 공을 찼어요.', 27, 'ball-kick'],
    ['아이가 손으로 공을 굴려요.', 21, 'ball-roll'],
    ['아이가 운동장에서 공을 차요.', 32, 'ball-kick'],
    ['아기가 그림책을 펼쳐요.', 13, 'book'],
    ['아이가 그림책의 책장을 넘겨요.', 40, 'book'],
    [scene, 15, 'build'], [scene, 50, 'build'], [scene, 62, 'build'],
    ['아기가 두 개의 장난감 중에서 인형을 골라요.', 20, 'choose'],
    ['아기가 두 모자 중 작은 모자를 골라요.', 18, 'choose'],
    ['아이가 바닥에 앉아 울고 있어요.', 39, 'cry'],
    ['아이가 크레용으로 종이에 선을 그어요.', 28, 'draw'],
    ['아이가 선생님에게 인형을 건네요.', 45, 'exchange'],
    ['아이가 혼자 장난감 자동차를 굴려요.', 45, 'explore'],
    ['아기가 손가락으로 인형을 가리켜요.', 13, 'gesture'],
    ['아기가 손가락으로 공을 가리켜요.', 16, 'gesture'],
    ['아기가 선생님의 손뼉 동작을 따라 해요.', 18, 'imitate'],
    ['아이가 퍼즐판에 조각을 맞춰요.', 25, 'puzzle'],
    ['아이가 퍼즐 조각을 제자리에 끼워요.', 64, 'puzzle'],
    ['아이가 인형을 내려놓고 다른 장난감을 집어요.', 43, 'switch'],
  ] as const;
  it.each(scenarios)('근거에 맞는 상황을 후보로 검색한다 · %s', (text, age, topic) => {
    const topics = findEvidence([text], age).map(c => c.passage.topic);
    expect(topics).toContain(topic);
    if (text.includes('색칠하지 않고')) expect(topics).not.toContain('draw');
  });
  it('모든 근거를 실제 관찰 문장과 해당 연령으로 검색할 수 있다', () => {
    const covered = new Set<string>();
    for (const [text, age, topic] of scenarios) {
      for (const {passage} of findEvidence([text], age)) {
        if (passage.topic === topic) covered.add(passage.id);
      }
    }
    const db = new DatabaseSync(new URL('../evidence/care-2026-11-20-v2.sqlite', import.meta.url), {readOnly:true});
    try {
      const missing = db.prepare('SELECT id FROM passage ORDER BY id').all()
        .map(row => String(row.id)).filter(id => !covered.has(id));
      expect(missing).toEqual([]);
    } finally { db.close(); }
  });
  it.each([
    '엄마가 인형에게 밥을 먹이는 시늉을 하고 아이는 옆에 서 있어요.',
    '아이가 종이에 그림을 그리는 화면을 보고 있어요.',
    '아이가 “블록을 높이 쌓아요”라는 말을 들었어요.',
    '아이가 그리지 않았어요. 선생님이 종이에 선을 그어요.',
    '아이가 정리함 옆에 앉아 바닥을 바라봐요.',
    '아이가 퍼즐 조각이 놓인 탁자 곁을 지나가요.',
    '아이가 두 개의 크레용 사이에 손을 올려놓고 있어요.',
    '아이가 책을 보는 것 같아요.',
    '아이가 탬버린 옆에서 잠시 멈춰 서 있어요.',
    '아이가 색깔 분류 교구 옆에 서 있어요.',
    '아이가 블록 쌓기를 멈췄어요.',
    '아이가 색칠책 옆에 서 있어요.',
    '아이가 그림책을 들고 창밖을 봐요.',
    '아이가 바구니에 든 과일을 보고 있어요.',
    '아이가 높은 곳에서 떨어졌어요. 아이가 장난감을 건네요.',
  ])('어른·화면·말·물건의 존재만으로 아이의 행동을 만들지 않는다 · %s', text => {
    expect(findEvidence([text], 40)).toEqual([]);
  });
  it('비슷한 소품이 있는 다른 역할놀이·음악 동작에는 전용 근거를 제외한다', () => {
    const doctor = findEvidence(['아이가 인형을 진찰하는 척해요.'], 32).map(c=>c.passage.topic);
    expect(doctor).toContain('pretend');
    expect(doctor).not.toContain('pretend-cook');
    const drum = findEvidence(['아이가 북을 두드려요.'], 52).map(c=>c.passage.topic);
    expect(drum).toContain('music');
    expect(drum).not.toContain('dance');
    expect(drum).not.toContain('rhythm');
  });
  it('화면에 나온 사람과 방 안의 아이를 분리해 실제 아이의 행동만 근거와 대조한다', () => {
    expect(findEvidence(['아이는 블록 앞에 앉아 있고 텔레비전에서 다른 아이들이 블록을 쌓아요.'], 40)).toEqual([]);
    expect(findEvidence(['아이가 서 있고 휴대폰 화면 속 다른 아이가 퍼즐 조각을 맞춰요.'], 40)).toEqual([]);
    for (const s of [
      '아이는 종이에 그림을 그려요. 모니터에서는 다른 아이들이 블록을 쌓아요.',
      '아이가 종이에 그림을 그리고 TV에서 친구가 블록을 쌓아요.',
      '태블릿에서는 다른 아이들이 블록을 쌓고 화면 앞의 아이는 종이에 그림을 그려요.',
    ]) {
      const hits = findEvidence([s],40);
      expect(hits.map(c=>c.passage.topic)).toContain('draw');
      expect(hits.every(c=>!c.observation.includes('블록'))).toBe(true);
    }
    expect(findEvidence(['영상에서 아이가 종이에 선을 그어요.'],40).map(c=>c.passage.topic)).toContain('draw');
    expect(findEvidence(['아이가 검지로 그림 속 기차를 가리켜요.'],44).map(c=>c.passage.topic)).toContain('gesture');
    expect(findEvidence(['아이가 서 있고 그림 속 다른 아이가 기차를 가리켜요.'],44)).toEqual([]);
  });
  it('하던 것을 놓고 새 놀잇감으로 옮겨가면 전환에 해당하는 근거를 우선한다', () => {
    const topics = findEvidence(['아이가 놀던 실로폰을 내려놓고 새 놀잇감으로 옮겨 갔어요.'],50).map(c=>c.passage.topic);
    expect(topics).toContain('switch');
    expect(topics).not.toContain('explore');
    expect(findEvidence(['아이가 새 장난감을 내려놓고 서 있어요.'],50).map(c=>c.passage.topic)).not.toContain('switch');
  });
  it('교사의 권한을 두 번 확인하고 출처·행동을 DB 값 그대로 서명한다', async () => {
    const access = vi.fn<typeof fetch>().mockImplementation(async () => ok());
    const { request, generate, log } = makeApp(access);
    const res = await request();
    expect(res.status).toBe(200);
    expect(access).toHaveBeenCalledTimes(2);
    expect(String(access.mock.calls[0]![0])).toBe('https://api.example.test/api/v1/children/1/ai-observations/3/review');
    expect(access.mock.calls[0]![1]).toMatchObject({redirect:'error',cache:'no-store',headers:{Authorization:'Bearer teacher-test'}});
    const { summary,recommendations,receipt } = JSON.parse(res.body);
    expect(recommendations).toHaveLength(1);
    const first = findEvidence([scene,pointing],45)[0]!;
    expect(recommendations[0]).toMatchObject({observation:scene,sourceId:first.passage.id,action:first.passage.action,reason:first.passage.reason});
    expect(verifyJwt(receipt,SECRET)).toMatchObject({aud:'hamkke-api-guidance',typ:'ai-guidance',sub:'9',cid:1,oid:3,summary,recommendations,corpusVersion:CORPUS_VERSION});
    expect(JSON.stringify(generate.mock.calls)).not.toContain('teacher-test');
    expect(JSON.stringify(log.mock.calls)).not.toContain(scene);
  });
  it('관찰·후속 동선과 서명된 자료의 출처를 화면용 묶음으로 함께 돌려준다', async () => {
    const access = vi.fn<typeof fetch>().mockImplementation(async () => ok({ ...context, display }));
    const res = await makeApp(access).request();
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body);
    const [recommendation] = body.recommendations;
    expect(body.display).toEqual({
      ...display,
      responseOptions:{ status:'PREVIEW', corpusVersion:CORPUS_VERSION, items:[{
        observation:recommendation.observation, action:recommendation.action, reason:recommendation.reason,
        source:{ id:recommendation.sourceId, title:recommendation.sourceTitle, publisher:recommendation.sourcePublisher,
          url:recommendation.sourceUrl, section:recommendation.sourceSection },
      }] },
    });
    expect(verifyJwt(body.receipt,SECRET)).not.toHaveProperty('display');
  });
  it('근거를 찾는 동안 코칭 공유가 철회되면 처음 읽은 코칭을 반환하지 않는다', async () => {
    const access = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(ok({ ...context, display }))
      .mockResolvedValueOnce(ok({ ...context, display:{ ...display, relatedCoaching:null } }));
    const res = await makeApp(access).request();
    expect(res.status).toBe(409);
    expect(res.body).not.toContain(display.relatedCoaching.title);
  });
  it('수정한 요약으로 재검색하며 지운 장면이 이전 시각 메모로 되살아나지 않는다', async () => {
    const {request,generate} = makeApp(vi.fn<typeof fetch>().mockImplementation(async()=>ok()));
    const res=await request({summary:'아이가 바닥에 가만히 앉아 있어요.'});
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({summary:'아이가 바닥에 가만히 앉아 있어요.', recommendations:[]});
    expect(generate).not.toHaveBeenCalled();
  });
  it('모델이 일치하는 근거 없음을 선택할 수 있고 범위를 벗어난 출처를 만들 수 없다', async () => {
    const candidates=findEvidence([scene],40);
    const provider={...fakeProvider(),generate:async()=> '{"indexes":[]}'};
    expect(await groundRecommendations(provider,candidates,new AbortController().signal)).toEqual([]);
    await expect(groundRecommendations({...provider,generate:async()=>'{"indexes":[987]}'},candidates,new AbortController().signal)).rejects.toThrow();
  });
  it('권한 없는 계정에는 추천을 작성하지 않고, 검토 중 공유가 철회된 경우에도 응답을 차단한다', async () => {
    const blocked=makeApp(vi.fn<typeof fetch>().mockImplementation(async()=>new Response(null,{status:404})));
    expect((await blocked.request()).status).toBe(404);
    expect(blocked.generate).not.toHaveBeenCalled();
    const revoked=makeApp(vi.fn<typeof fetch>().mockResolvedValueOnce(ok()).mockResolvedValueOnce(new Response(null,{status:404})));
    const response=await revoked.request();
    expect(response.status).toBe(404);
    expect(response.body).not.toContain(scene);
    const closed=makeApp(vi.fn<typeof fetch>().mockImplementation(async()=>ok({...context,status:'PUBLISHED'})));
    expect((await closed.request()).status).toBe(409);
    expect(closed.generate).not.toHaveBeenCalled();
  });
  it('인증 누락·근거 URL 주입·긴 입력은 권한 조회 전에 거부한다', async () => {
    const {request,fetchApi}=makeApp();
    expect((await request({},null)).status).toBe(401);
    expect((await request({url:'https://example.com/'})).status).toBe(400);
    expect((await request({summary:'가'.repeat(501)})).status).toBe(400);
    expect(fetchApi).not.toHaveBeenCalled();
  });
});
