import { expect, it, vi } from 'vitest';
import { confirmedHairNote } from '../src/hairContact.ts';
import { buildPrompt } from '../src/prompt.ts';
import { reviewedObservation } from '../src/visualReview.ts';
import type { VisionProvider, VisionRequest } from '../src/provider.ts';

const contact = { hand:'CHILD', hair:'ADULT', contact:'GRASP' } as const;
const direction = '아이가 어른의 머리카락을 강하게 잡아요.';

it('명시된 두 역할이 사진에서 확인될 때 동작을 남기고 힘의 세기는 적지 않는다', () => {
  expect(confirmedHairNote(direction, contact)).toBe('아이가 어른의 머리카락을 잡고 있어요.');
  expect(confirmedHairNote(direction, { ...contact, contact:'TOUCH' })).toBe('아이가 어른의 머리카락에 손을 대고 있어요.');
});

it('사진과 초안의 역할이 다르면 사람을 바꿔 쓰지 않는다', () => {
  expect(confirmedHairNote(direction, { ...contact, hand:'ADULT',hair:'CHILD' })).toBe('머리 쪽에 손이 닿아 있어요.');
  expect(confirmedHairNote(direction, { ...contact, hand:'UNCLEAR' })).toBe('머리 쪽에 손이 닿아 있어요.');
  expect(confirmedHairNote(direction, { ...contact, contact:'NONE' })).toBeNull();
  expect(confirmedHairNote('아이가 어른의 머리카락을 잡지 않아요.', contact)).toBeNull();
  expect(confirmedHairNote('아이가 들고 있는 어른의 손이 아이의 머리카락을 잡아요.', contact))
    .toBe('머리 쪽에 손이 닿아 있어요.');
});

it('정확한 장면의 사진에서만 역할을 다시 확인하고 같은 장면의 다른 동작은 보존한다', async () => {
  const times = [1,2,3];
  const phrase = '어른이 아이를 안고 걷고, 아이가 어른의 머리카락을 잡아요.';
  const generate = vi.fn(async (request:VisionRequest) => {
    if (request.system.startsWith('Check only this one silent')) return JSON.stringify({ ...contact, hand:'ADULT', hair:'CHILD' });
    if (request.system.startsWith('Look at the silent images')) {
      return JSON.stringify({ appearance:'MIXED_AGES', participants:'MULTIPLE_VISIBLE_PARTICIPANTS', activity:'OTHER_JOINT_ACTION' });
    }
    if (request.system.startsWith('Inspect ONLY')) {
      return JSON.stringify({ actor1:'adult at left carries the child', actor2:'child at center with hand raised',
        visible:'TWO_OR_MORE_PEOPLE', secondAction:'HELPING_WITH_AN_ORDINARY_TASK', focusAction:'OTHER', singleRole:'UNCLEAR' });
    }
    return JSON.stringify({ summary:phrase, moments:[{t:2,note:phrase},{t:3,note:'아이가 울고 있어요.'}],
      childStates:['UPSET_CRYING'],adultResponses:[],peopleCount:2 });
  });
  const provider:VisionProvider = { modelVersion:'test', isReady:async()=>true, generate };
  const { observation } = await reviewedObservation(provider,{ ...buildPrompt(times,4), images:['early','contact','later'],
    signal:new AbortController().signal },times);
  const calls = generate.mock.calls.map(([request]) => request).filter(request => request.system.startsWith('Check only this one silent'));
  expect(calls.map(call => call.images)).toEqual([['contact']]);
  expect(observation?.moments).toEqual([
    { t:2,note:'머리 쪽에 손이 닿아 있어요. 어른이 아이를 안고 걷고 있어요.' },{ t:3,note:'아이가 울고 있어요.' },
  ]);
  expect(observation?.summary).not.toMatch(/머리카락을 잡/);
  expect(observation?.childStates).toContain('UPSET_CRYING');
});
