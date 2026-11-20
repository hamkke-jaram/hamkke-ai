import { sourceForExcerpt } from './observationEvidence.ts';

// These are principles behind a classroom adaptation. The specific toy, time
// or words in the activity are examples, not quotations from the publication.
interface Reference { sourceKey: string; section: string; excerpt: string; page?: number }
const references = {
  play: { sourceKey: 'MOE-CARE-2024', page: 3, section: '제1장 Ⅱ.2 교수·학습 가 (PDF 3쪽)',
    excerpt: '영유아가 흥미와 관심에 따라 놀이에 자유롭게 참여하고 즐기도록 한다.' },
  observation: { sourceKey: 'MOE-CARE-2024', page: 4, section: '제1장 Ⅱ.3 평가 라 (PDF 4쪽)',
    excerpt: '평가의 결과는 영유아에 대한 이해와 표준보육과정 운영 개선을 위한 자료로 활용할 수 있다.' },
  attention: { sourceKey: 'MOHW-POSITIVE-129', page: 3, section: '참고1 · 긍정 양육의 실천방법 「온전히 집중하기」 (PDF 3쪽)',
    excerpt: '자녀와 보내는 시간에는 온전히 자녀에게만 집중해주세요.' },
  empathy: { sourceKey: 'MOHW-POSITIVE-129', page: 3, section: '참고1 · 긍정 양육의 실천방법 「경청하고 공감하기」 (PDF 3쪽)',
    excerpt: '자녀의 의사표현을 적극적으로 들어주고 자녀의 감정에 공감해주세요.' },
  turns: { sourceKey: 'dfe-interactions', section: 'What this means in practice · 차례를 주고받고 기다리기',
    excerpt: 'Taking turns and waiting for a child to respond' },
  language: { sourceKey: 'dfe-interactions', section: 'What this means in practice · 놀이 중 아이의 표현에 말을 더하기',
    excerpt: 'If you join in with children’s play and comment, repeat back, wonder aloud and add new words' },
  visual: { sourceKey: 'dfe-interactions', section: 'What this means in practice · 사물과 그림을 이용한 소통',
    excerpt: 'use objects, pictures, or visual cues, such as showing a coat to indicate going outside.' },
} satisfies Record<string, Reference>;

interface Activity {
  codes: string[];
  title: string;
  action: string;
  reference: keyof typeof references;
  reason: string;
}

export function classroomEvidence(activity: Activity) {
  const ref: Reference = references[activity.reference];
  const doc = sourceForExcerpt(ref.sourceKey, ref.excerpt);
  if (!doc) return null;
  return { reason: activity.reason, sourceId: ref.sourceKey + '-' + activity.reference,
    sourceTitle: doc.title, sourcePublisher: doc.publisher, sourceSection: ref.section,
    sourceUrl: ref.page ? doc.url + '#page=' + ref.page : doc.url };
}

export const classroomActivities: Activity[] = [
  {
    codes: ['FIRST-01', 'JP-S-01', 'GEN-S-01'],
    title: '익숙한 일과에 짧은 놀이 시간 두기',
    reference: 'play',
    reason: '놀이 시간을 비워 두면 아이가 관심을 보인 놀잇감을 직접 고르고 원하는 동안 탐색할 수 있어요.',
    action: '오전 자유놀이가 시작되면 아이가 고른 놀잇감 곁에 잠시 앉아 주세요. 다음 날에도 같은 때에 자리를 내어 주고, 아이가 자리를 뜨면 놀이를 마쳐요.',
  },
  {
    codes: ['FIRST-01', 'GEN-S-01', 'GEN-A-01', 'GEN-G-01'],
    title: '놀이에서 본 한 장면 남기기',
    reference: 'observation',
    reason: '실제로 본 행동과 선생님의 반응을 함께 적어 두면 다음 놀이를 준비할 때 무엇을 이어갈지 되짚어 볼 수 있어요.',
    action: '자유놀이가 끝나면 아이가 한 행동과 선생님이 어떻게 응답했는지 한 줄로 적어 보세요. 다음 자유놀이 때 같은 방법을 써 볼지 떠올리는 단서가 돼요.',
  },
  {
    codes: ['FIRST-02', 'JP-A-01', 'JP-S-01'],
    title: '아이가 고른 놀이를 곁에서 따라 하기',
    reference: 'play',
    reason: '아이가 선택한 놀이에 선생님이 맞추면, 아이가 하던 탐색을 이어가면서 함께 놀 기회도 열어 둘 수 있어요.',
    action: '아이가 블록을 굴리면 옆에서 다른 블록을 한 번 굴려 보세요. 아이가 자기 놀이를 이어가면 새 규칙을 더하지 않고 그 속도를 따라가요.',
  },
  {
    codes: ['FIRST-02', 'JP-A-01', 'JP-G-01'],
    title: '놀이를 볼 수 있는 자리에 앉기',
    reference: 'attention',
    reason: '아이가 보고 있는 놀잇감에 주의를 기울이면 어느 순간에 손을 뻗거나 도움을 청하는지 알아차리기 쉬워요.',
    action: '놀이 매트에서 아이 손이 닿는 자리를 비워 두고 옆에 앉으세요. 아이가 바라보는 놀잇감을 함께 보고, 선생님 쪽을 보라고 요구하지 않아도 돼요.',
  },
  {
    codes: ['JP-G-01', 'JP-G-02'],
    title: '공을 굴리고 다음 차례 기다리기',
    reference: 'turns',
    reason: '한 번 굴린 뒤 기다리면 선생님이 연달아 이끌지 않아도 아이가 공을 만지거나 굴리는 것으로 자기 차례에 참여할 수 있어요.',
    action: '바닥에 앉아 부드러운 공을 아이 쪽으로 천천히 한 번 굴려 주세요. 아이가 공을 만지거나 굴리는 동안 기다리고, 되돌아오면 다시 굴려요.',
  },
  {
    codes: ['JP-G-02'],
    title: '블록 하나로 차례 보여 주기',
    reference: 'turns',
    reason: '선생님 차례를 짧게 마치고 기다리면 아이가 다음 블록을 올릴지, 다른 놀이를 할지 스스로 반응할 시간이 생겨요.',
    action: '블록을 하나 올린 뒤 남은 블록을 아이 가까이에 두세요. 아이가 손을 뻗으면 기다리고, 다른 놀이를 고르면 그 선택을 따라가요.',
  },
  {
    codes: ['RS-G-01', 'GEN-A-02'],
    title: '아이가 낸 소리에 한 단어 더하기',
    reference: 'language',
    reason: '아이가 방금 한 말에 단어 하나를 더하면 놀이를 이어가면서 그 상황에 맞는 표현을 들을 수 있어요.',
    action: '놀이 중 아이가 “공”이라고 하면 “공 굴려”처럼 짧게 받아 주세요. 다시 말해 달라고 하지 않고 아이가 놀이를 이어갈 시간을 주세요.',
  },
  {
    codes: ['RS-G-01', 'RS-S-01', 'GEN-A-02'],
    title: '손짓에 짧은 말로 답하기',
    reference: 'turns',
    reason: '손짓을 아이의 차례로 받아들이고 짧게 답한 뒤 기다리면 아이가 익숙한 방식으로 대화를 이어갈 수 있어요.',
    action: '아이가 놀잇감을 가리키면 그쪽을 보며 “자동차구나”처럼 한마디로 답해 주세요. 손짓이나 소리만으로도 다음 차례를 이어갈 수 있어요.',
  },
  {
    codes: ['RS-A-01', 'RS-S-01'],
    title: '기다린 뒤 아이가 고른 것 건네기',
    reference: 'turns',
    reason: '선택지를 보여 준 뒤 기다리면 선생님이 먼저 정하기 전에 아이가 손짓으로 원하는 것을 표현할 수 있어요.',
    action: '두 가지 놀잇감을 보여 주고 아이가 고를 시간을 잠깐 주세요. 손을 뻗거나 가리키면 “이거구나” 하고 바로 건네세요. 말로 답해야 받을 수 있는 조건은 두지 않아요.',
  },
  {
    codes: ['RS-A-01'],
    title: '그림책에서 다음 장을 기다려 주기',
    reference: 'turns',
    reason: '장을 넘기기 전에 잠시 멈추면 아이가 손짓이나 소리로 책 읽기에 참여할 차례가 생겨요.',
    action: '그림책을 함께 볼 때 장을 넘기기 전에 잠깐 멈추세요. 아이가 손을 내밀거나 소리를 내면 “넘길까?” 하고 그 손짓에 맞춰 다음 장을 펴 주세요.',
  },
  {
    codes: ['CA-G-01', 'CA-S-01'],
    title: '정리 전에 다음 일과 보여 주기',
    reference: 'visual',
    reason: '일과를 나타내는 그림을 말과 함께 보여 주면 다음에 무엇을 하는지 눈으로도 확인할 수 있어요.',
    action: '놀이를 정리하기 전에 그림 일정표에서 지금 하는 놀이와 다음 일과를 차례로 짚어 주세요. “놀이 다음은 간식이야”처럼 실제 일정에 맞춰 짧게 말해요.',
  },
  {
    codes: ['CA-G-01', 'CA-S-01'],
    title: '교실을 옮기기 전에 미리 알리기',
    reference: 'visual',
    reason: '이동할 곳을 그림으로 보여 주면 바깥놀이가 끝난 뒤 어디로 가는지 짧은 말과 연결해 볼 수 있어요.',
    action: '바깥놀이를 마치기 전에 교실 그림을 먼저 보여 주세요. “한 번 더 타고 교실로 가자”라고 알려 주고 약속한 차례가 끝나면 함께 움직여요.',
  },
  {
    codes: ['CA-A-01'],
    title: '마음을 가라앉힐 때 조용히 곁에 있기',
    reference: 'empathy',
    reason: '교사가 곁에서 울음과 몸짓에 주의를 기울이면 원인을 미리 정하지 않고 아이의 느낌에 응답할 수 있어요.',
    action: '놀이 중 아이가 울면 편안해하는 거리에서 낮은 목소리로 “여기 있을게”라고 말해 주세요. 울음이 잦아들면 아이가 다시 놀이를 고를 시간을 주세요.',
  },
  {
    codes: ['CA-A-01'],
    title: '울음이 잦아들면 짧게 응답하기',
    reference: 'empathy',
    reason: '손을 내미는 표현부터 받아 주면 아이가 말을 해야 한다는 부담 없이 다음으로 필요한 도움을 나타낼 수 있어요.',
    action: '울음이 잦아들고 아이가 손을 내밀면 “같이 있을게”라고 짧게 답해 주세요. 무슨 일이었는지 바로 묻기보다 아이가 가리키거나 움직일 때까지 기다려요.',
  },
  {
    codes: ['GEN-A-01', 'GEN-G-01'],
    title: '눈앞의 행동을 구체적으로 알아주기',
    reference: 'language',
    reason: '방금 한 행동을 짧은 말로 들려주면 아이가 놀이에 집중한 채 그 움직임과 표현을 함께 경험할 수 있어요.',
    action: '아이가 블록을 포개면 “블록 두 개를 포갰네”처럼 방금 본 행동을 한마디로 들려주세요. 말을 따라 하게 하지 않고 아이가 다음 놀이를 이어가도록 기다려요.',
  },
];
