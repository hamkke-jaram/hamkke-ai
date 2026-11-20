import { describe, expect, it } from 'vitest';
import type { Observation } from '../src/observation.ts';
import type { VisionProvider, VisionRequest } from '../src/provider.ts';
import { ProviderTimeoutError } from '../src/provider.ts';
import { buildPrompt } from '../src/prompt.ts';
import { applyReview, reviewedObservation, screenLines } from '../src/visualReview.ts';
import { decodeFrameWitness } from '../src/frameWitness.ts';

const draft = (summary: string, fields: Partial<Observation> = {}): Observation => ({
  summary, moments: [], childStates: [], adultResponses: [], peopleCount: 1, ...fields,
});
const joint = {
  appearance: 'MIXED_AGES', participants: 'MULTIPLE_VISIBLE_PARTICIPANTS', activity: 'SHARED_PLAY',
} as const;
const single = {
  appearance: 'PARTS_ONLY', participants: 'ONE_VISIBLE_PARTICIPANT', activity: 'NO_CLEAR_PLAY',
} as const;
const singleChild = {visible:'ONE_PERSON',secondAction:'NO_SECOND_VISIBLE_PERSON',focusAction:'OTHER',singleRole:'CLEAR_CHILD'} as const;
const photoPair = {visible:'TWO_OR_MORE_PEOPLE',secondAction:'PLAYING_THE_SAME_GAME',focusAction:'OTHER',singleRole:'UNCLEAR'} as const;
const playing = (s: string) => draft(s, {
  peopleCount: 2, childStates: ['PLAYING_TOGETHER'], adultResponses: ['JOINING_PLAY', 'TALKING'],
});

describe('같은 화면에서 호칭·대화·놀이만 다시 확인', () => {
  it('손만 보이면 손을 쓴 동작과 물체를 남기고 연령과 대화 태그를 보류한다', () => {
    const before = draft('어른의 손이 컵을 잡아요. 아이에게 말을 걸어요.', {
      moments: [{t: 1, note: '어른의 오른손이 컵을 잡아요.'}], childStates: ['FOCUSED'], adultResponses: ['TALKING'],
    });
    expect(applyReview(before, single)).toEqual(draft('손이 컵을 잡아요.', {
      moments: [{t: 1, note: '오른손이 컵을 잡아요.'}],
    }));
  });

  it.each(['PARTS_ONLY', 'CLEAR_ADULTS_ONLY'] as const)('걷는 아이를 한 번의 %s 판정으로 바꾸지 않는다', appearance => {
    const before = draft('아이가 손을 흔들며 앞으로 걸어가요.', { childStates: ['MOVING_AROUND'] });
    expect(applyReview(before, { ...single, appearance })).toEqual(before);
  });

  it('서 있는 성인의 단독 작업 설명을 보존한다', () => {
    const before = draft('어른이 소포를 손에 들고 서 있어요.');
    expect(applyReview(before, { ...single, appearance: 'CLEAR_CHILDREN_ONLY' })).toEqual(before);
  });

  it.each([
    ['CLEAR_CHILDREN_ONLY', '두 아이가 공을 주고받아요. 두 아이가 함께 놀아요.'],
    ['CLEAR_ADULTS_ONLY', '두 어른이 공을 주고받아요. 두 어른이 함께 놀아요.'],
  ] as const)('여러 명의 공동놀이와 원래 태그를 %s 연령 분류로 편집하지 않는다', (appearance, summary) => {
    expect(applyReview(playing(summary), { ...joint, appearance })).toEqual({ ...playing(summary), adultResponses: ['JOINING_PLAY'] });
  });

  it('함께 놀고 있는 아이와 어른의 놀이와 태그를 보존한다', () => {
    const summary = '아이와 어른이 공을 주고받아요. 아이와 어른이 함께 놀아요.';
    expect(applyReview(playing(summary), joint)).toEqual({ ...playing(summary), adultResponses: ['JOINING_PLAY'] });
  });

  it('두 사람이 공을 주고받는 기록은 놀이 목적이 불확실해도 보존한다', () => {
    const summary = '두 사람이 공을 주고받아요. 두 사람이 함께 놀아요.';
    expect(applyReview(playing(summary), { ...joint, activity: 'UNRESOLVED' })?.summary).toBe(summary);
  });

  it('두 사람이 같은 방에 서 있는 것만으로 함께 놀았다고 쓰지 않는다', () => {
    const before = playing('아이와 어른이 같은 방에 서 있어요. 함께 놀아요.');
    expect(applyReview(before, { ...joint, activity: 'NO_CLEAR_PLAY' })).toEqual(
      draft('아이와 어른이 같은 방에 서 있어요.', { peopleCount:2 }));
  });

  it.each(['NO_CLEAR_PLAY', 'UNRESOLVED'] as const)('점검이 %s이고 둘째 사람의 동작이 없으면 공동놀이를 보류한다', activity => {
    const before = playing('아이와 어른이 함께 놀이를 해요.');
    const check = { appearance: 'UNRESOLVED', participants: 'ONE_VISIBLE_PARTICIPANT', activity } as const;
    expect(applyReview(before, check)).toEqual(draft('화면에서 구체적인 동작을 확인하기 어려워요.', { peopleCount:2 }));
  });

  it('초안이 명시한 두 역할과 공 주고받기를 나이 점검 하나만으로 지우지 않는다', () => {
    const before = playing('어른과 아이가 공을 주고받아요.');
    expect(applyReview(before, { ...joint, appearance: 'CLEAR_ADULTS_ONLY' })).toEqual({ ...before, adultResponses: ['JOINING_PLAY'] });
  });

  it('하나의 문장에 섞인 말걸기만 빼고 확인된 동작을 남긴다', () => {
    const before = draft('아이가 공을 들고 말을 걸어요.', {
      moments: [{ t: 0, note: '말을 걸며 상자를 들어요.' }],
    });
    expect(applyReview(before, { ...single, appearance: 'CLEAR_CHILDREN_ONLY' })).toEqual(
      draft('아이가 공을 들고 있어요.', { moments: [{t: 0, note: '상자를 들어요.'}] }));
  });

  it('단독 인물과 손 클로즈업에서 원래 동작에 덧붙여진 공동놀이만 뺀다', () => {
    const before = draft('어른의 손이 종이를 잡고 함께 놀아요.', { adultResponses: ['JOINING_PLAY'] });
    expect(applyReview(before, single)).toEqual(draft('손이 종이를 잡고 있어요.'));
  });

  it('서로 다른 활동 해석이어도 2인 초안의 행동과 기존 공동놀이 태그를 보존한다', () => {
    const summary = '두 사람이 상자를 함께 들어 올려요.';
    expect(applyReview(playing(summary), { ...joint, activity: 'OTHER_JOINT_ACTION' })).toEqual({ ...playing(summary), adultResponses: ['JOINING_PLAY'] });
  });

  it('서로 공을 건네는 두 역할이 보이면 모든 연령·인원 분류에서 근거가 있는 공동놀이를 보존한다', () => {
    const before = playing('두 사람이 공을 주고받아요.');
    for (const appearance of ['UNRESOLVED', 'MIXED_AGES', 'CLEAR_CHILDREN_ONLY', 'CLEAR_ADULTS_ONLY', 'PARTS_ONLY'] as const) {
      for (const participants of ['ONE_VISIBLE_PARTICIPANT', 'MULTIPLE_VISIBLE_PARTICIPANTS', 'UNRESOLVED'] as const) {
        for (const activity of ['SHARED_PLAY', 'SOLO_PLAY', 'OTHER_JOINT_ACTION', 'NO_CLEAR_PLAY', 'UNRESOLVED'] as const) {
          expect(applyReview(before, { appearance, participants, activity })).toEqual({ ...before, adultResponses: ['JOINING_PLAY'] });
        }
      }
    }
  });

  it('서로 다른 두 행위자의 손을 기록하면 손 장면이라는 이유로 놀이를 지우지 않는다', () => {
    const before = playing('두 사람의 손이 번갈아 움직여요. 함께 놀아요.');
    expect(applyReview(before, single)).toEqual({ ...before, adultResponses: ['JOINING_PLAY'] });
  });

  it('잘못된 인원 2와 함께 한 손 및 물체만 기술하면 호칭과 근거 없는 공동놀이를 걷어낸다', () => {
    const before = playing('어른의 오른손이 컵을 잡아요. 함께 놀아요.');
    expect(applyReview(before, single)).toEqual(draft('오른손이 컵을 잡아요.', { peopleCount: 2 }));
  });

  it('한 명이라는 양쪽 근거가 일치하면 공동놀이는 빼고 명시된 단독놀이는 남긴다', () => {
    const before = draft('아이가 혼자 놀아요. 함께 놀아요.', {
      childStates: ['PLAYING_TOGETHER', 'PLAYING_ALONE'], adultResponses: ['JOINING_PLAY'],
    });
    expect(applyReview(before, { ...single, appearance: 'UNRESOLVED' })).toEqual(draft('아이가 혼자 놀아요.', { childStates: ['PLAYING_ALONE'] }));
  });

  it('공동놀이와 말걸기가 한 문장이면 확인 가능한 놀이 절과 태그를 보존한다', () => {
    const before = playing('두 사람이 함께 놀며 대화를 나눠요.');
    expect(applyReview(before, joint)).toEqual({
      ...before, summary: '두 사람이 함께 놀아요.', adultResponses: ['JOINING_PLAY'],
    });
  });

  it('소리를 단정하는 절 앞에서 가장 긴 신체 행동을 남기고 다른 사람의 보이는 동작도 살린다', () => {
    const before = draft('아이가 모자를 들고 창문을 바라보며 질문하고, 어른은 아이를 보며 대답해요.', {
      peopleCount:2, moments:[{ t:1, note:'어른이 팔을 움직이며 말을 하고 있어요.' }],
    });
    expect(applyReview(before, joint)).toEqual({ ...before,
      summary:'아이가 모자를 들고 창문을 바라봐요. 어른은 아이를 봐요.',
      moments:[{ t:1, note:'어른이 팔을 움직여요.' }] });
  });

  it('대화 다음 동작의 주체를 보존하고 말하려는 의도를 동작으로 바꾸지 않는다', () => {
    const before = draft('아이가 말하면서 고개를 돌려요. 어른은 설명하려고 대답해요.');
    expect(applyReview(before, joint)?.summary).toBe('아이가 고개를 돌려요.');
  });

  it('근거가 태그뿐이고 화면 점검에 한 행위자만 있으면 추측한 둘째 사람을 고친다', () => {
    const before = { ...playing(''), summary:null };
    expect(applyReview(before, { ...single, appearance:'UNRESOLVED', participation:'ONE_PERSON_DOES_THE_ACTION' }, [singleChild,singleChild])).toEqual(
      draft('화면에 한 사람이 보여요.'));
    expect(applyReview(before, { ...joint,participation:'TWO_PEOPLE_PLAY_THE_SAME_GAME' })?.childStates).toContain('PLAYING_TOGETHER');
  });

  it('아이가 단독으로 물체를 움직이면 구체적인 활동과 시점 메모는 남긴다', () => {
    const before = playing('아이가 물건을 상자에 넣어요. 어른과 함께 놀아요.');
    expect(applyReview(before, { ...single, appearance:'CLEAR_CHILDREN_ONLY', participation:'ONE_PERSON_DOES_THE_ACTION' }, [singleChild,singleChild])).toEqual(
      draft('아이가 물건을 상자에 넣어요.'));
  });

  it('옆에서 지켜보는 사람의 존재와 그 사람이 놀이에 참여했다는 단정을 구별한다', () => {
    const before = playing('아이가 공을 굴려요. 어른은 옆에서 지켜봐요.');
    expect(applyReview(before, { ...joint, activity:'SOLO_PLAY', participation:'ANOTHER_PERSON_ONLY_WATCHES' })).toEqual(
      draft(before.summary!, {peopleCount:2}));
  });

  const soloPlay = { ...joint, activity:'SOLO_PLAY', participation:'ONE_PERSON_DOES_THE_ACTION' } as const;
  const pairWitness = (actor1:string,actor2:string,secondAction='PLAYING_THE_SAME_GAME') => decodeFrameWitness(JSON.stringify({
    ...photoPair, actor1, actor2, secondAction,
  }));

  it('같은 블록에 손을 뻗은 한 장을 공동놀이 또는 달래기로 올리지 않고 두 사람의 실제 동작을 남긴다', () => {
    const photo = pairWitness('Child at center stacks the blocks with hands', 'Adult at right crouches and reaches toward a block');
    expect(photo.secondAction).toBe('PLAYING_THE_SAME_GAME');
    expect(photo.concretePlayPair).toBe(false);
    const before = draft('아이가 블록을 옮겨요. 어른이 블록 쪽으로 손을 뻗고 웅크려요. 두 사람이 함께 놀아요.', {
      peopleCount:2, childStates:['PLAYING_TOGETHER','FOCUSED'], adultResponses:['JOINING_PLAY','COMFORTING'],
    });
    expect(applyReview(before, soloPlay, [photo], [2])).toEqual(draft(
      '아이가 블록을 옮겨요. 어른이 블록 쪽으로 손을 뻗고 웅크려요.', { peopleCount:2, childStates:['FOCUSED'] }));
  });

  it('단독놀이 판정이 있어도 두 사람이 공에 하는 구체적인 동작을 두 장에서 확인하면 공동놀이를 남긴다', () => {
    const before = playing('아이와 어른이 같이 놀아요.');
    const photos = [
      pairWitness('Child at left passes a ball with both hands', 'Adult on right catches the ball with both hands'),
      pairWitness('Child at left catches the ball with both hands', 'Adult on right passes the ball with both hands'),
    ];
    expect(photos.every(p=>p.concretePlayPair)).toBe(true);
    expect(applyReview(before, soloPlay, photos, [2,2])).toEqual({ ...before, adultResponses:['JOINING_PLAY'] });
  });

  it('귀를 가리는 자세에서 울음이나 손을 잡는 일을 추측하지 않고 같은 문장의 귀 동작을 남긴다', () => {
    const before = draft('아이가 갑자기 울면서 손으로 귀를 가리고 어른의 손을 잡아요.', {
      peopleCount:2, childStates:['UPSET_CRYING'], adultResponses:['COMFORTING'],
      moments:[{t:12.5,note:'어른이 아이의 손을 잡고 블록을 건드리고 있어요.'}, {t:13.1,note:'아이가 귀를 가리고 울어요.'}],
    });
    const photos = [
      pairWitness('Child at left raises empty hands', 'Adult at right pulls a hand back from a block','ONLY_WATCHING_OR_NEARBY'),
      pairWitness('Child at left covers ears with both hands', 'Adult at right stays crouched','ONLY_WATCHING_OR_NEARBY'),
    ];
    expect(applyReview(before, soloPlay, photos, [2,2], null,[12.5,13.1])).toEqual(draft('아이가 손으로 귀를 가려요.', {
      peopleCount:2,moments:[{t:12.5,note:'어른이 블록을 건드리고 있어요.'},{t:13.1,note:'아이가 귀를 가리고 있어요.'}],
    }));
  });

  it('아이를 안는 접촉과 귀를 가릴 때 눈에 보이는 눈물이 확인되면 둘 다 살린다', () => {
    const before = draft('아이가 귀를 가리고 울어요. 어른이 아이를 안아요.', {
      peopleCount:2, moments:[{t:4,note:'아이가 귀를 가리고 울어요.'}], childStates:['UPSET_CRYING'], adultResponses:['COMFORTING'],
    });
    const photo = pairWitness('Child at left covers ears with visible tears on cheeks', 'Adult on right cradles the child in both arms', 'HELPING_WITH_AN_ORDINARY_TASK');
    expect(photo.visibleChildTears).toBe(true);
    expect(photo.adultComfortContact).toBe(true);
    expect(applyReview(before,{...joint,activity:'NO_CLEAR_PLAY'},[photo],[2],null,[4])).toEqual(before);
  });

  it('손을 잡는 행동은 같은 시각에 역할까지 확인한 경우만 시점 기록에 남긴다', () => {
    const note = '어른이 아이의 손을 잡아요.';
    const before = draft(note, {peopleCount:2, moments:[{t:1,note},{t:3,note}]});
    const photo = pairWitness('Child at left stretches a hand forward', 'Adult on right holds the child’s hand', 'HELPING_WITH_AN_ORDINARY_TASK');
    expect(photo.adultGraspsChildHand).toBe(true);
    const result = applyReview(before,joint,[photo],[2],null,[3]);
    expect(result?.summary).toBe(note);
    expect(result?.moments).toEqual([{t:3,note}]);
  });

  it('귀를 가린 시각의 일반 자세를 구체화하고 주변의 근거 없는 울음·손 뻗기·건네기를 뺀다', () => {
    const before = draft('아이가 어른에게 손을 뻗어요. 어른이 옆에서 웅크려요.', {
      peopleCount:2, childStates:['UPSET_CRYING','SEEKING_ADULT','FOCUSED'], moments:[
        {t:10.5,note:'어른이 아이에게 블록을 건네주며 쌓는 모습을 도와줘요.'},
        {t:12.5,note:'아이가 갑자기 손을 들어 올리고 얼굴을 붉히며 울어요.'},
        {t:14.1,note:'아이가 어른에게 손을 뻗고 어른이 옆에서 웅크려요.'},
        {t:15.8,note:'아이가 두 손을 머리에 올리고 있어요. 어른이 앉아 있어요.'},
      ],
    });
    const ear = pairWitness('A child in a yellow shirt sits on the floor with hands over ears.',
      'Adult on the right crouches with hands on the floor','ONLY_WATCHING_OR_NEARBY');
    expect(ear.childCoversOwnEars).toBe(true);
    const result = applyReview(before,soloPlay,[ear,ear],[2,2],null,[13.8,15.8]);
    expect(result).toEqual(draft('어른이 옆에서 웅크려요.', {peopleCount:2,childStates:['FOCUSED'],moments:[
      {t:12.5,note:'아이가 갑자기 손을 들어 올리고 있어요.'},
      {t:14.1,note:'어른이 옆에서 웅크려요.'},
      {t:15.8,note:'아이가 손으로 귀를 가려요. 어른이 앉아 있어요.'},
    ]}));
  });

  it('귀 주변에 손을 드는 것만으로 귀를 가렸다고 확정하지 않고 다른 시각에 확인한 행동을 남긴다', () => {
    const note = '아이가 어른에게 손을 뻗어요.';
    const before = draft('아이가 두 손을 머리에 올려요.', {
      peopleCount:2, childStates:['SEEKING_ADULT'], moments:[{t:8,note:'아이가 울어요.'},{t:14.1,note}],
    });
    const almost = pairWitness('Child in center holds both hands near ears', 'Adult on the right stands nearby','ONLY_WATCHING_OR_NEARBY');
    const reaches = pairWitness('Child on the left reaches a hand toward the adult', 'Adult at right stands beside the child','ONLY_WATCHING_OR_NEARBY');
    const ear = pairWitness('Child at left covers their ears with hands', 'Adult at right stands beside the child','ONLY_WATCHING_OR_NEARBY');
    expect(almost.childCoversOwnEars).toBe(false);
    expect(reaches.childReachesAdult).toBe(true);
    const result = applyReview(before,soloPlay,[almost,reaches,ear],[2,2,2],null,[10,14.1,15.8]);
    expect(result?.moments).toEqual([{t:8,note:'아이가 울어요.'},{t:14.1,note},{t:15.8,note:'아이가 손으로 귀를 가려요.'}]);
    expect(result?.childStates).toEqual(['SEEKING_ADULT']);
  });

  it('귀 뒤에 손을 올리는 말의 순서도 구별하고 공동 행동을 뺀 뒤 아이의 장난감 동작은 남긴다', () => {
    const before = draft('어른과 아이가 장난감 블록을 쌓아요. 아이가 어른과 함께 장난감을 만져요.', {
      peopleCount:2, childStates:['UPSET_CRYING'], moments:[
        {t:10.9,note:'아이가 어른과 함께 장난감을 만져요.'},
        {t:17.4,note:'아이가 두 손을 귀 뒤에 올리고 어른을 바라보며 울어요.'},
      ],
    });
    expect(applyReview(before,soloPlay)).toEqual(draft('아이가 장난감을 만져요.', {peopleCount:2,moments:[
      {t:10.9,note:'아이가 장난감을 만져요.'},
      {t:17.4,note:'아이가 두 손을 귀 뒤에 올리고 어른을 바라봐요.'},
    ]}));
  });

  it('손이 얼굴을 가린 사진에서 울음을 단정하지 않고 귀를 가리는 자세는 놀이와 구분한다', () => {
    const before = draft('아이는 손으로 귀를 가리고 어른을 바라보며 놀아요.', {
      peopleCount:2, childStates:['UPSET_CRYING'],
      moments:[{t:13.1,note:'아이가 두 손을 얼굴에 덮고 울어요.'}],
    });
    const result = applyReview(before, soloPlay);
    expect(result?.summary).toContain('귀를 가리고');
    expect(result?.summary).not.toContain('놀아요');
    expect(result?.moments[0]?.note).toContain('얼굴');
    expect(result?.moments[0]?.note).not.toContain('울어요');
    expect(result?.childStates).not.toContain('UPSET_CRYING');
  });

  it('귀를 막는 장면에서 접촉이나 놀이의 근거가 없으면 아이가 한 동작만 남긴다', () => {
    const before = playing('아이가 손으로 귀를 가리고, 어른이 손가락을 움직여 줘요.');
    before.moments = [
      {t:10.5,note:'어른이 아이의 손에 블록을 건네주며 쌓는 모습을 도와줘요.'},
      {t:12.5,note:'아이가 손을 들어 흔들어요.'},
      {t:13.8,note:'아이가 양손으로 귀를 막고 울음을 터뜨려요.'},
    ];
    const checked = applyReview(before,{...joint,activity:'OTHER_JOINT_ACTION'});
    expect(checked?.summary).toBe('아이가 손으로 귀를 가리고 있어요.');
    expect(checked?.moments.map(m=>m.t)).toEqual([12.5,13.8]);
    expect(checked?.moments[1]?.note).toBe('아이가 양손으로 귀를 막고 있어요.');
    expect(checked?.childStates).not.toContain('PLAYING_TOGETHER');
  });

  it('단독 물체 동작이 여러 사진에서 일치하면 초안의 다른 어른과 역할 태그를 지운다', () => {
    const before = draft('어른과 아이가 함께 물건을 놓아요.', {peopleCount:2, moments:[{t:0,note:'어른이 상자를 올려요.'}],
      adultResponses:['JOINING_PLAY','WAITING'],childStates:['FOCUSED','SEEKING_ADULT']});
    const evidence = {...singleChild,focusAction:'PLACING_OBJECT_ON_ANOTHER'} as const;
    expect(applyReview(before,joint,[evidence,evidence])).toEqual(draft('아이가 물건을 다른 물건 위에 놓아요.',
      {childStates:['FOCUSED'],moments:[{t:0,note:'사람이 상자를 올려요.'}]}));
  });

  it('한 장에서 실제 다른 참가자가 보이면 다른 시점의 한 사람을 이유로 놀이를 지우지 않는다', () => {
    const before=playing('두 사람이 공을 주고받아요.');
    expect(applyReview(before,single,[singleChild,singleChild,photoPair])).toEqual({...before,adultResponses:['JOINING_PLAY']});
  });

  it('두 사람이 보이는 일상 작업을 되풀이해서 확인하면 작업 설명을 살리고 놀이 태그를 뺀다', () => {
    const before=playing('아이와 어른이 함께 상자를 옮겨요.');
    const work={...photoPair,secondAction:'HELPING_WITH_AN_ORDINARY_TASK'} as const;
    expect(applyReview(before,joint,[work,work])).toEqual(draft(before.summary!,{peopleCount:2}));
  });

  it('공통 사진 점검만으로 여러 사람이라는 인원을 한 명으로 바꾸지 않는다', () => {
    const before=playing('아이가 혼자 앉아 있어요.');
    expect(applyReview(before,single,[])?.peopleCount).toBe(2);
    expect(applyReview(before,single,[singleChild,{...singleChild,visible:'UNCLEAR'}])?.peopleCount).toBe(2);
  });

  it('한 사진이라도 서로 다른 사람 박스가 둘이면 같은 사람 한 명으로 덮어쓰지 않는다', () => {
    const before=playing('어른과 아이가 공을 주고받아요.');
    expect(applyReview(before,joint,[singleChild,singleChild,singleChild],[1,2,1])).toEqual({...before,adultResponses:['JOINING_PLAY']});
  });

  it('한 명만 검출된 시점과 미검출된 시점이 섞이면 인원을 확정하지 않고 근거 없는 공동놀이를 보류한다', () => {
    const before={...playing(''), summary:null};
    const unknown={...singleChild,visible:'UNCLEAR',secondAction:'UNCLEAR',focusAction:'UNCLEAR',singleRole:'UNCLEAR'} as const;
    const result=applyReview(before,joint,[unknown,unknown,unknown],[0,0,1]);
    expect(result?.peopleCount).toBe(2);
    expect(result?.adultResponses).toEqual([]);
    expect(result?.childStates).toEqual([]);
    expect(result?.summary).toBe('확인한 장면에서 구체적인 동작을 구별하기 어려워요.');
    expect(applyReview(before,joint,[unknown,unknown,unknown],[0,0,0])?.peopleCount).toBe(2);
  });

  it('반복된 한 행위자 서술과 독립 검출이 일치하면 모순되는 프레임별 인원 enum을 그대로 세지 않는다', () => {
    const observed=['TWO_OR_MORE_PEOPLE','NO_PERSON','TWO_OR_MORE_PEOPLE'].map(visible => decodeFrameWitness(JSON.stringify({
      actor1:'Foreground person places a green piece on another piece',actor2:'NONE',visible,
      secondAction:'NO_SECOND_VISIBLE_PERSON',singleRole:'UNCLEAR',focusAction:'PLACING_OBJECT_ON_ANOTHER',
    })));
    const before=playing('아이와 어른이 함께 물건을 놓아요.');
    expect(applyReview(before,joint,observed,[0,0,1])).toEqual(draft('한 사람이 물건을 다른 물건 위에 놓아요.'));
    expect(applyReview(before,joint,observed,[0,0,0])?.peopleCount).toBe(2);
    expect(applyReview(before,joint,observed,[2,2,2])?.peopleCount).toBe(2);
  });

  it('몸을 받쳐 주는 두 사람을 신체 일부로 분류해도 실제 지지 동작을 보존한다', () => {
    const before=draft('어른이 아이를 한 팔로 안고 있어요.',{peopleCount:2});
    const mixed={...singleChild,visible:'BODY_PARTS_ONLY',singleRole:'UNCLEAR'} as const;
    expect(applyReview(before,single,[mixed,mixed],[2,2])).toEqual(before);
    const supported=decodeFrameWitness(JSON.stringify({actor1:'Small seated person leaning forward',actor2:'Another adult is supporting the torso',
      visible:'BODY_PARTS_ONLY',secondAction:'UNCLEAR',focusAction:'OTHER',singleRole:'UNCLEAR'}));
    expect(applyReview(before,single,[supported,supported],[0,0])).toEqual(before);
  });

  it('손의 그림 동작이 반복되고 다른 손의 역할은 확인되지 않으면 CPU 미검출만으로 인원수를 수정하지 않는다', () => {
    const before=playing('어른의 손이 종이에 기호를 그려요. 아이와 함께 놀아요.');
    const mark=decodeFrameWitness(JSON.stringify({actor1:'Hand tracing a pattern upon the surface',actor2:'NONE',visible:'TWO_OR_MORE_PEOPLE',
      secondAction:'NO_SECOND_VISIBLE_PERSON',focusAction:'PLACING_OBJECT_ON_ANOTHER',singleRole:'UNCLEAR'}));
    expect(applyReview(before,joint,[mark,mark,mark],[0,0,0])).toEqual(draft('사람의 손이 종이에 기호를 그려요.',{peopleCount:2}));
  });

  it('두 사람이 주고받았다는 설명을 걸러도 한 사람이 웃고 걸으며 허리를 숙인 동작을 원래 주체와 보존한다', () => {
    const before=playing('아이는 웃는 얼굴로 어른에게 물건을 건네요. 아이가 걸어가요. 아이가 서서 몸을 숙여요.');
    const person=decodeFrameWitness(JSON.stringify({actor1:'Smiling child standing at the center',actor2:'NONE',visible:'ONE_PERSON',
      secondAction:'NO_SECOND_VISIBLE_PERSON',focusAction:'UNCLEAR',singleRole:'UNCLEAR'}));
    expect(applyReview(before,joint,[person,person],[1,1])).toEqual(draft('아이는 웃어요. 아이가 걸어가요. 아이가 서서 몸을 숙여요.'));
  });

  it('쌓인 물건이나 놀이를 설명한 문구를 올려놓기 동작으로 바꾸지 않는다', () => {
    const frame = (actor1:string) => decodeFrameWitness(JSON.stringify({actor1,actor2:'NONE',visible:'ONE_PERSON',
      secondAction:'NO_SECOND_VISIBLE_PERSON',focusAction:'PLACING_OBJECT_ON_ANOTHER',singleRole:'UNCLEAR'}));
    expect(frame('A person on the left watches a stack of toys').focusAction).toBe('UNCLEAR');
    expect(frame('Child on the right is playing with a ball').focusAction).toBe('UNCLEAR');
    const before={...playing(''),summary:null};
    const placed=frame('Child on the right places a toy on another');
    expect(applyReview(before,joint,[placed,placed],[1,1])?.summary).not.toContain('놓아요');
  });

  const bookFrame = (actor1:string, actor2 = 'NONE') => decodeFrameWitness(JSON.stringify({
    actor1, actor2, visible:'NO_PERSON', secondAction:'NO_SECOND_VISIBLE_PERSON',
    focusAction:'PLACING_OBJECT_ON_ANOTHER', singleRole:'UNCLEAR',
  }));

  it.each([
    "A person's torso and hands are visible placing a book on top of a tall stack.",
    "A person's torso and hands are visible, placing books on top of a stack.",
  ])('물체 배치의 단수·복수 표현이 확인되면 동작을 요약에 남긴다. %s', actor1 => {
    const before=playing('아이와 어른이 책을 들고 서 있어요.');
    const placing=bookFrame(actor1);
    const holding=bookFrame('Person in foreground holds a tall stack of books.');
    const standing=bookFrame('A child is standing beside the stacked books.');
    expect(placing.visible).toBe('UNCLEAR');
    expect(placing.describesObjectPlacement).toBe(true);
    expect(applyReview(before,joint,[placing,holding,standing],[0,0,1])).toEqual(draft('한 사람이 물건을 다른 물건 위에 놓아요.'));
    expect(applyReview(before,joint,[placing,standing,standing],[0,0,1])?.summary).not.toContain('다른 물건 위');
    expect(applyReview(before,joint,[placing,holding,standing],[0,0,0])?.summary).not.toContain('다른 물건 위');
    expect(applyReview(before,joint,[placing,holding,standing],[0,2,1])?.summary).not.toContain('다른 물건 위');
    expect(applyReview(before,joint,[placing,holding,photoPair],[0,0,1])?.summary).not.toContain('다른 물건 위');
    expect(applyReview(playing('아이와 어른이 쌓인 책 옆에 서 있어요.'),joint,[placing,holding,standing],[0,0,1])?.summary)
      .not.toContain('다른 물건 위');
  });

  it.each([
    'A person is standing beside a pile of books.',
    'A person holds a book above a tall stack.',
    "A person isn't placing a book on top of a stack.",
    'A person might be placing a book on top of a stack.',
    'A person places a hand on top of a stack.',
    'A person places both hands on top of a stack.',
    'A person places a book on top of a different child.',
    'A person places a book on top of the floor.',
  ])('확인되지 않는 물체 동작을 복원하지 않는다. %s', actor1 => {
    const observed=bookFrame(actor1);
    const holding=bookFrame('Person in foreground holds a tall stack of books.');
    expect(observed.describesObjectPlacement).toBe(false);
    expect(applyReview(playing('아이와 어른이 책을 들고 서 있어요.'),joint,[observed,holding,holding],[0,0,1])?.summary)
      .not.toContain('다른 물건 위');
  });

  it('직접 보이는 두 번째 행위자가 있으면 물체를 올려놓았다는 서술을 단독 행동의 근거로 쓰지 않는다', () => {
    const observed=bookFrame('Left person placing a book on top of a stack', 'Right person holds a book');
    expect(observed.visible).toBe('TWO_OR_MORE_PEOPLE');
    expect(observed.describesObjectPlacement).toBe(false);
  });
});

const times = [0, 1];
const request = (): VisionRequest => ({ ...buildPrompt(times, 1), images: ['a', 'b'], signal: new AbortController().signal });
function mockProvider(generate: VisionProvider['generate']): VisionProvider {
  return { modelVersion: 'primary', generate, async isReady() { return true; } };
}

describe('원본 생성 및 별도 화면 점검 순서', () => {
  it('원래 지시문을 먼저 사용하고 검토 모델이 다르더라도 초안을 실제 작성한 모델 이름을 반환한다', async () => {
    const input = request();
    const calls: VisionRequest[] = [];
    const provider = mockProvider(async r => {
      calls.push(r);
      return calls.length === 1
        ? { text: JSON.stringify(playing('아이와 어른이 공을 주고받아요.')), modelVersion: 'actual-writer' }
        : { text: JSON.stringify(joint), modelVersion: 'review-fallback' };
    });
    const result = await reviewedObservation(provider, input, times);
    expect(result.modelVersion).toBe('actual-writer');
    expect(calls[0]).toBe(input);
    expect(calls[1]?.images).toBe(input.images);
    expect(calls[1]?.signal).toBe(input.signal);
    expect(calls[1]?.user).not.toContain('공을 주고받아요');
    expect(calls.slice(2).map(c=>c.images)).toEqual([['a'],['b']]);
    expect(result.observation?.adultResponses).toEqual(['JOINING_PLAY']);
  });

  it.each(['invalid', 'unavailable'])('점검 응답이 %s이면 초안 속 점검 값을 무시하고 단독 자세를 보존한다', async mode => {
    let n = 0;
    const provider = mockProvider(async () => {
      if (++n === 1) return JSON.stringify({ ...playing('아이가 혼자 앉아 있어요. 함께 놀아요. 말을 걸어요.'), visualReview: joint });
      if (mode === 'unavailable') throw new Error('unavailable');
      return JSON.stringify({ ...joint, participants: 'bad' });
    });
    const result = await reviewedObservation(provider, request(), times);
    expect(result.observation).toEqual(draft('아이가 혼자 앉아 있어요.', { peopleCount:2 }));
  });

  it('시간 제한은 공통 제한시간 처리로 넘긴다', async () => {
    let n = 0;
    const provider = mockProvider(async () => {
      if (++n === 1) return JSON.stringify(draft('아이가 서 있어요.'));
      throw new ProviderTimeoutError();
    });
    await expect(reviewedObservation(provider, request(), times)).rejects.toBeInstanceOf(ProviderTimeoutError);
  });

  it('빈 화면은 원래 결과를 반환하고 점검 호출이 없다', async () => {
    let n = 0;
    const before = draft('화면에 아이가 보이지 않아요.', { peopleCount: 0 });
    const result = await reviewedObservation(mockProvider(async () => { n++; return JSON.stringify(before); }), request(), times);
    expect(n).toBe(1);
    expect(result.observation).toEqual(before);
  });
});

describe('입 모양과 미소 확인', () => {
  const roleReview = {appearance:'CLEAR_CHILDREN_ONLY',participants:'ONE_VISIBLE_PARTICIPANT',activity:'UNRESOLVED'};
  const verify = async (before: Observation, child: string, adult: string) => {
    const snapshots: string[][] = [];
    const input = request();
    const provider = mockProvider(async frame => {
      if (frame === input) return JSON.stringify(before);
      if (frame.system.startsWith('Look only at this exact silent photograph.')) {
        snapshots.push([...frame.images]);
        return JSON.stringify({child:frame.images[0] === 'a' ? child : 'UNCLEAR',adult});
      }
      if (frame.system.startsWith('Inspect this exact single silent photograph')) {
        return JSON.stringify({position:frame.images[0] === 'b' ? 'COVERING' : 'NO_COVER'});
      }
      if (frame.system.startsWith('Check spatial contact')) return '{"left":"OVER_EAR","right":"UNCLEAR"}';
      return JSON.stringify(roleReview);
    });
    return { ...await reviewedObservation(provider,input,times), snapshots };
  };

  it('입을 벌린 아이를 웃었다고 쓰지 않고 같은 장면의 손동작과 다른 시각의 귀 가림을 보존한다', async () => {
    const falseSmile = '아이가 손을 들어 올리고 웃어요.';
    const before = draft(falseSmile,{
      moments:[{t:0,note:falseSmile},{t:1,note:'아이가 손으로 귀를 가려요.'}],
    });
    const {observation,snapshots} = await verify(before,'OPEN_MOUTH','SMILE');
    expect(snapshots).toEqual([['a']]);
    expect(observation?.summary).toBe('아이가 손을 들어 올리고 있어요. 아이가 입을 벌리고 있어요.');
    expect(observation?.moments).toEqual([
      {t:0,note:'아이가 손을 들어 올리고 있어요. 아이가 입을 벌리고 있어요.'},
      {t:1,note:'아이가 손으로 귀를 가려요.'},
    ]);
  });

  it('분명한 미소는 그 사진의 인물과 시각에 기록하고 다른 시각의 표정은 보류한다', async () => {
    const before = draft('아이가 웃어요.',{moments:[
      {t:0,note:'아이가 웃는 얼굴로 앉아 있어요.'},{t:1,note:'아이가 웃으며 손을 들어요.'},
    ]});
    const {observation,snapshots} = await verify(before,'SMILE','UNCLEAR');
    expect(snapshots).toEqual([['a'],['b']]);
    expect(observation?.summary).toBe('아이가 미소를 지어요.');
    expect(observation?.moments).toEqual([
      {t:0,note:'아이가 앉아 있어요. 아이가 미소를 지어요.'},
      {t:1,note:'아이가 손을 들어요.'},
    ]);
  });

  it('시각이 없는 교사용 한 줄에 확인하지 않은 표정을 표시하지 않는다', () => {
    const checked = draft('어른이 미소를 지어요.',{
      childLine:'아이가 웃어요.',parentLine:'어른이 옆에 앉아요.',peopleCount:2,
    });
    expect(screenLines(checked)?.childLine).toBeUndefined();
    expect(screenLines(checked)?.parentLine).toBe('어른이 옆에 앉아요.');
  });
});

describe('귀 가림의 사진 시각 확인', () => {
  const clipTimes = [10.5,12.5,13.1,13.8,15.4];
  const clipImages = ['block','raise','near','cover','later'];
  const testTiming = async (before: Observation, states: Record<string,string>, times = clipTimes) => {
    const inspected: string[] = [];
    const input: VisionRequest = {...buildPrompt(times,20.1),images:clipImages,signal:new AbortController().signal};
    const provider = mockProvider(async req => {
      if (req === input) return JSON.stringify(before);
      if (req.system.startsWith('Inspect this exact single silent photograph')) {
        inspected.push(req.images[0]!);
        return JSON.stringify({position:states[req.images[0]!] ?? 'UNCLEAR'});
      }
      if (req.system.startsWith('Check spatial contact')) return '{"left":"OVER_EAR","right":"UNCLEAR"}';
      return JSON.stringify({appearance:'CLEAR_CHILDREN_ONLY',participants:'ONE_VISIBLE_PARTICIPANT',activity:'SOLO_PLAY'});
    });
    const {observation} = await reviewedObservation(provider,input,times);
    return {observation,inspected};
  };

  it('귀에 손이 닿기 전 기록을 확인된 사진으로 옮기고 독립적인 동작의 시각은 바꾸지 않는다',async () => {
    const before = draft('아이가 블록을 쌓아요. 아이가 귀를 가려요.',{moments:[
      {t:10.5,note:'아이가 블록을 쌓아요.'},
      {t:12.5,note:'아이가 손을 들어 올려요.'},
      {t:13.1,note:'아이가 귀를 가려요.'},
      {t:13.8,note:'아이가 고개를 돌려요.'},
    ]});
    const {observation,inspected} = await testTiming(before,{raise:'HANDS_RAISED',near:'HANDS_RAISED',cover:'COVERING'});
    expect(inspected).toEqual(['near','cover']);
    expect(observation?.moments).toEqual([
      before.moments[0],before.moments[1],
      {t:13.1,note:'아이가 손을 들어 올린 채 있어요.'},
      {t:13.8,note:'아이가 고개를 돌려요. 아이가 손으로 귀를 가려요.'},
    ]);
  });

  it('앞 시각의 사진 때문에 귀 가림 기록을 더 앞당기지 않는다',async () => {
    const before = draft('아이가 귀를 막아요.',{moments:[{t:15.4,note:'아이가 귀를 막아요.'}]});
    const {observation,inspected} = await testTiming(before,{cover:'COVERING',later:'COVERING'});
    expect(inspected).toEqual(['later']);
    expect(observation?.moments).toEqual([{t:15.4,note:'아이가 손으로 귀를 가려요.'}]);
  });

  it('닿은 손과 가림을 구분하고 확인되지 않은 가림을 요약과 교사용 문장에도 남기지 않는다',async () => {
    const before = draft('아이가 귀를 가려요.',{
      childLine:'아이가 귀를 막아요.',moments:[{t:13.1,note:'아이가 귀를 막아요.'}],
    });
    const {observation} = await testTiming(before,{raise:'HANDS_RAISED',near:'TOUCHING',cover:'UNCLEAR'});
    expect(observation?.moments).toEqual([{t:13.1,note:'아이가 귀에 손을 대고 있어요.'}]);
    expect(observation?.summary).toBeNull();
    expect(observation?.childLine).toBeUndefined();
  });

  it('머리를 감싸는 자세를 해당 사진에서 귀 가림으로 확인한 경우만 구체화한다',async () => {
    const before = draft('아이가 두 손으로 머리를 감싸요.',{moments:[
      {t:12.5,note:'아이가 손을 들어 올려요.'},
      {t:13.8,note:'아이가 두 손으로 머리를 감싸요.'},
    ]});
    const confirmed = await testTiming(before,{cover:'COVERING'});
    expect(confirmed.observation?.moments).toEqual([
      before.moments[0],{t:13.8,note:'아이가 손으로 귀를 가려요.'},
    ]);
    const unclear = await testTiming(before,{cover:'UNCLEAR',later:'NO_COVER'});
    expect(unclear.observation?.moments).toEqual(before.moments);
  });

  it('시작 후보보다 두 번째 인접 사진에서 처음 가렸으면 그 사진의 시각을 사용한다',async () => {
    const before = draft('아이가 귀를 가려요.',{moments:[
      {t:10.9,note:'아이가 귀를 막아요.'},
      {t:12.5,note:'아이가 손을 들어요.'},
    ]});
    const {observation,inspected} = await testTiming(before,{block:'NO_COVER',raise:'HANDS_RAISED',near:'COVERING'},
      [10.9,12.5,14.1,15.8,17.4]);
    expect(inspected).toEqual(['block','raise','near']);
    expect(observation?.moments).toEqual([before.moments[1],{t:14.1,note:'아이가 손으로 귀를 가려요.'}]);
  });
});
