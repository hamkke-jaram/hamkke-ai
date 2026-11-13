// 관찰 기록 프롬프트 obs-v1.
// 지시문이나 태그 목록을 바꾸면 PROMPT_VERSION 을 올리고 docs/observation.md 를 함께 고친다.
import {
  ADULT_RESPONSES,
  ADULT_RESPONSE_LABELS,
  CHILD_STATES,
  CHILD_STATE_LABELS,
  MAX_MOMENTS,
  MAX_NOTE_LENGTH,
  MAX_SUMMARY_LENGTH,
  MAX_TAGS,
} from './observation.ts';

export const PROMPT_VERSION = 'obs-v1';

export interface Prompt {
  system: string;
  user: string;
  schema: Record<string, unknown>;
}

const childStateLines = CHILD_STATES.map((tag) => `- ${tag}: ${CHILD_STATE_LABELS[tag]}`).join('\n');
const adultResponseLines = ADULT_RESPONSES.map((tag) => `- ${tag}: ${ADULT_RESPONSE_LABELS[tag]}`).join('\n');

const SYSTEM = `당신은 아이와 어른이 함께 있는 장면 사진을 보고, 보이는 것만 적는 관찰 기록 도우미예요.

규칙
1. 사진에 실제로 보이는 것만 시간 순서대로 적어요. 보이지 않는 것, 사진 밖의 일, 소리나 말의 내용은 적지 않아요.
2. summary 와 note 의 모든 문장은 한국어 해요체로 짧게 쓰고 '요.'로 끝내요(예: "아이가 블록을 쌓아요."). '~습니다', '~합니다', '~한다'로 끝내지 않아요.
3. 사람은 '아이', '어른'이라고만 불러요. 이름, 나이, 생김새나 옷차림에 대한 느낌은 쓰지 않아요.
4. 왜 그런지 까닭을 짐작하지 않아요. 조언이나 부탁하는 말도 쓰지 않아요.
5. 아이나 어른을 평가하거나 어떤 아이라고 이름 붙이지 않아요. 잘한다, 못한다, 많다, 적다 같은 말 없이 움직임과 모습만 적어요.
6. 태그는 아래 목록에 있는 값만 골라요. 사진에서 분명히 보일 때만 고르고, 애매하면 고르지 않아요.
7. 아이가 보이지 않으면 summary 에 "화면에 아이가 보이지 않아요."라고 적고, childStates, adultResponses, moments 는 모두 빈 배열로 둬요.
8. moments 에는 서로 다른 순간만 적어요. 같은 말을 되풀이하지 않아요.

childStates — 아이 모습 (0~${MAX_TAGS}개)
${childStateLines}

adultResponses — 어른 반응 (0~${MAX_TAGS}개)
${adultResponseLines}

답은 JSON 객체 하나만 써요.
- summary: 전체 장면을 1~3문장, ${MAX_SUMMARY_LENGTH}자 안쪽으로
- childStates, adultResponses: 위 목록의 값
- moments: 눈에 띄는 순간 0~${MAX_MOMENTS}개. t 는 그 사진의 시각(초)을 그대로, note 는 짧은 한 문장(${MAX_NOTE_LENGTH}자 안쪽)
- peopleCount: 사진에 보이는 사람 수. 0, 1, 2, 3 가운데 하나(세 명보다 많아도 3)`;

/** 프롬프트에 적는 시각. 소수 첫째 자리까지만 보여 준다(응답의 t 는 서버가 보낸 시각으로 다시 맞춘다). */
export function displayTime(t: number): number {
  return Math.round(t * 10) / 10;
}

export function buildPrompt(frameTimes: readonly number[], durationSec: number | null): Prompt {
  const shown = frameTimes.map(displayTime);
  const lines = shown.map((t, i) => `- 사진 ${i + 1}: t=${t}`);
  const length = durationSec === null ? '' : ` 전체 길이는 약 ${Math.round(durationSec)}초예요.`;
  const user = `사진 ${shown.length}장을 시간 순서대로 보냈어요.${length}
${lines.join('\n')}
이 사진들에 보이는 것을 규칙대로 JSON 으로 적어 주세요.`;

  const schema = {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      childStates: { type: 'array', items: { type: 'string', enum: [...CHILD_STATES] }, maxItems: MAX_TAGS },
      adultResponses: { type: 'array', items: { type: 'string', enum: [...ADULT_RESPONSES] }, maxItems: MAX_TAGS },
      moments: {
        type: 'array',
        maxItems: MAX_MOMENTS,
        items: {
          type: 'object',
          properties: {
            t: { type: 'number', enum: [...new Set(shown)] },
            note: { type: 'string' },
          },
          required: ['t', 'note'],
        },
      },
      peopleCount: { type: 'integer', enum: [0, 1, 2, 3] },
    },
    required: ['summary', 'childStates', 'adultResponses', 'moments', 'peopleCount'],
  };
  return { system: SYSTEM, user, schema };
}
