import { describe, expect, it } from 'vitest';
import type { Observation } from '../src/observation.ts';
import { reconcilePresence } from '../src/presence.ts';
import { reviewedObservation } from '../src/visualReview.ts';
import { buildPrompt } from '../src/prompt.ts';

const record = (summary:string|null,fields:Partial<Observation>={}):Observation=>({
  summary,peopleCount:1,childStates:[],adultResponses:[],moments:[],...fields,
});

describe('연령에 한정된 부재 문장의 범위 보존',()=>{
  it('같은 필드에서 사람 전체의 부재로 넓어진 곳만 지우고 다음 독립 동작을 남긴다',()=>{
    const old=record('아이가 걸어요. 화면에는 어른이 보이지 않아요. 아이가 손을 들어요.',
      {childStates:['MOVING_AROUND']});
    const edited={...old,summary:'아이가 걸어요. 화면에는 사람이 보이지 않아요. 아이가 손을 들어요.'};
    expect(reconcilePresence(edited,old)).toEqual({...edited,summary:'아이가 걸어요. 아이가 손을 들어요.'});
  });
  it.each([
    ['어른은 없고, 아이가 걸어가요.','사람은 없고, 아이가 걸어가요.','아이가 걸어가요.'],
    ['아이가 걸어가고, 어른은 없어요.','아이가 걸어가고, 사람은 없어요.','아이가 걸어가고 있어요.'],
    ['아이가 걸어가고 있고 어른은 없어요.','아이가 걸어가고 있고 사람은 없어요.','아이가 걸어가고 있어요.'],
    ['아이는 화면에서 보이지 않지만 손이 움직여요.','사람은 화면에서 보이지 않지만 손이 움직여요.','손이 움직여요.'],
  ])('접속된 부재 표현만 걷어낸다 (%s)',(old,changed,expected)=>{
    expect(reconcilePresence(record(changed),record(old))?.summary).toBe(expected);
  });
  it('같은 타임스탬프의 근거만 사용하고 원래부터 비어 있던 장면을 남긴다',()=>{
    const original=record('아이가 걸어요.', {moments:[{t:0,note:'화면에 사람이 보이지 않아요.'},{t:2,note:'어른은 없어요.'}]});
    const final={...original,moments:[{t:0,note:'화면에 사람이 보이지 않아요.'},{t:2,note:'사람은 없어요.'},{t:4,note:'사람은 없어요.'}]};
    expect(reconcilePresence(final,original)?.moments).toEqual([
      final.moments[0],{t:2,note:'이 시점의 동작은 분명하지 않아요.'},final.moments[2]]);
  });
  it.each([
    ['다른 어른은 없어요.','다른 사람은 없어요.'],['어른은 손이 안 보여요.','사람은 손이 안 보여요.'],
    ['어른은 물체를 안 봐요.','사람은 물체를 안 봐요.'],['어른은 잠시 화면 밖으로 나갔어요.','사람은 잠시 화면 밖으로 나갔어요.'],
    ['잠시, 어른은 없어요.','잠시, 사람은 없어요.'],['어른이 잘 보이지 않아요.','사람이 잘 보이지 않아요.'],
    ['이 장면에는 어른이 없어요.','이 장면에는 사람이 없어요.'],
    ['화면에 사람이 보이지 않아요.','화면에 사람이 보이지 않아요.'],
    ['어른은 없어요. 사람은 없어요.','사람은 없어요.'],['화면에 어른이 없어요.','영상에서 사람이 없어요.'],
  ])('부정의 대상·장소·시각·기원이 불확실하면 원문을 보존한다 (%s)',(old,changed)=>{
    const final=record(changed);
    expect(reconcilePresence(final,record(old))).toBe(final);
  });
  it('원초안 근거 없이 바꾸지 않고 무인 장면을 그대로 유지한다',()=>{
    const final=record('사람이 없어요.',{peopleCount:0});
    expect(reconcilePresence(final,record('어른이 없어요.'))).toBe(final);
    expect(reconcilePresence(null,null)).toBeNull();
    const positive=record('사람이 없어요.');
    expect(reconcilePresence(positive)).toBe(positive);
    expect(reconcilePresence(positive,record('어른이 없어요.'))?.summary).toBe('구체적인 동작을 확인하기 어려워요.');
  });
  it('서비스 보정 함수도 같은 최종 확인을 수행한다',async()=>{
    const original=record('어른의 손이 컵을 잡아요. 어른은 없어요.');
    let calls=0;
    const p={modelVersion:'mock',async isReady(){return true;},async generate(){return JSON.stringify(++calls===1?original:
      {appearance:'PARTS_ONLY',participants:'ONE_VISIBLE_PARTICIPANT',activity:'NO_CLEAR_PLAY'});}};
    const request={...buildPrompt([0],1), images:['fake'],signal:new AbortController().signal};
    expect((await reviewedObservation(p,request,[0])).observation).toEqual(record('손이 컵을 잡아요.'));
    expect(calls).toBe(2);
  });
});
