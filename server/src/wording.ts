// 문장 검사에 쓰는 낱말 목록 (hamkke-api docs/ai-observation.md 6장 '문장 검사').
//
// 이 파일은 모델이 쓴 문장을 걸러 내려고 금지 표현 목록을 그대로 담고 있다.
// 그래서 scripts/check-expressions.mjs 의 검수 대상에서 이 파일 하나만 뺀다.
// 다른 파일(테스트 포함)에는 이 낱말들을 적지 않고, 여기서 내보낸 값을 가져다 쓴다.

/**
 * 금지 표현. scripts/check-expressions.mjs 의 FORBIDDEN 과 같은 목록으로 유지한다
 * (server/test/wording.test.ts 가 두 목록이 같은지 확인한다).
 * 검수 스크립트의 허용 목록(고유명사)은 모델 출력에는 적용하지 않는다.
 */
export const FORBIDDEN_PATTERNS: readonly RegExp[] = [
  /진단/, /판별/, /선별/, /위험도/, /치료/, /증상/, /예방/, /경계선\s*지능/, /정확도/,
  /위험\s*예측/, /WHO\s*프로그램/, /\b(Hanen|ESDM|PACT|JASPER)\b/,
  /diagnos/i, /screening/i, /risk/i, /treatment/i, /symptom/i, /therap/i, /accuracy/i,
  /predict/i, /prevent/i, /borderline/i,
];

/** 평가·분류·원인 추정·조언처럼 읽히는 말 (명세 6장의 목록 그대로). */
export const EVALUATIVE_TERMS: readonly string[] = [
  '문제', '장애', '이상', '정상', '비정상', '지연', '부족', '산만', '공격', '과잉', '결핍', '의심',
  '해야', '하세요', '바랍니다', '권장',
];

/**
 * 조언·부탁으로 읽히는 말투. 명세 2장 4번은 조언이 나오면 버리라고 하는데, 위 목록의 '하세요'만으로는
 * '안아 주세요', '말을 걸어 보세요', '달래 주면 좋겠어요' 같은 해요체 조언이 그대로 지나간다.
 * 그래서 낱말이 아니라 어미까지 본다. 버리는 쪽으로만 넓힌 것이라 hamkke-api 의 두 번째 검사와 어긋나지 않는다.
 */
export const ADVICE_PATTERNS: readonly RegExp[] = [
  /세요(?![가-힣])/, // 주세요·보세요·마세요·드세요 …
  /십시오|시길|시기\s*바라/,
  /좋겠|좋을\s*(것|거|듯)|(는|은)\s*(게|것이|편이)\s*좋|면\s*좋아요/,
  /면\s*(돼요|되어요|됩니다)/,
  /필요|추천|권해|권합|권유|바라요|바래요/,
];

/** 까닭이나 속마음을 짐작하는 말투('졸려서 우는 것 같아요', '~ 때문이에요', '졸린가 봐요'). */
export const GUESS_PATTERNS: readonly RegExp[] = [
  /때문|덕분/,
  /(것|거|듯)\s*같/,
  /듯\s*(해|합|하|싶)/,
  /(^|\s)아마(도)?(?=\s)/,
  /어쩌면|추측|짐작|추정/,
  /[가-힣]나\s?봐요/, // 자나 봐요, 좋아하나 봐요
];

/** '-ㄴ가 봐요'(졸린가 봐요, 우는가 봐요). '아이가 봐요'처럼 받침 없는 말 뒤의 '가'는 주격 조사라 건너뛴다. */
function hasGuessEnding(text: string): boolean {
  for (const match of text.matchAll(/([가-힣])가\s*봐요/g)) {
    const finalConsonant = (match[1]!.charCodeAt(0) - 0xac00) % 28;
    if (finalConsonant === 4) return true; // 받침 ㄴ
  }
  return false;
}

/**
 * 명세는 이름·나이·외모 평가를 프롬프트에서 막으라고만 한다. 프롬프트를 어긴 출력에 대비해
 * 눈에 띄는 형태(나이 표기, 생김새를 평가하는 말)는 서버에서도 한 번 더 걸러 낸다.
 * 흔한 관찰 문장('공을 통통 튀겨요', '블록 3세트', '자세 살펴봐요')이 걸리지 않게 좁게 잡는다:
 * '살' 뒤에 펴·피·짝·며·살·금이 오면 나이가 아니고(살펴, 살짝, 살며시 …), 수사는 낱말의 처음일 때만 본다.
 */
export const PERSONAL_PATTERNS: readonly RegExp[] = [
  /\d+\s*살(?![펴피짝며살금])/,
  /\d+\s*개월/,
  /\d+\s*세(?![트대기션팅워우웠])/, // 3세·3세쯤은 걸리고 3세트·2세대는 지나간다
  /(^|[^가-힣])(열\s?)?(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*살(?![펴피짝며살금])/,
  /예쁘|예쁜|예뻐|귀엽|귀여|잘생|못생|뚱뚱|통통(하|한|해|했)|날씬|말랐/,
];

/** 문장에 걸러 낼 표현이 하나도 없으면 true. */
export function passesWordingCheck(text: string): boolean {
  for (const pattern of FORBIDDEN_PATTERNS) if (pattern.test(text)) return false;
  for (const term of EVALUATIVE_TERMS) if (text.includes(term)) return false;
  for (const pattern of ADVICE_PATTERNS) if (pattern.test(text)) return false;
  for (const pattern of GUESS_PATTERNS) if (pattern.test(text)) return false;
  if (hasGuessEnding(text)) return false;
  for (const pattern of PERSONAL_PATTERNS) if (pattern.test(text)) return false;
  return true;
}

/** 테스트에서 쓰는 예시. FORBIDDEN_PATTERNS 의 각 항목에 걸리는 낱말을 하나 이상 담는다. */
export const FORBIDDEN_SAMPLES: readonly string[] = [
  '진단', '판별', '선별', '위험도', '치료', '증상', '예방', '경계선 지능', '정확도',
  '위험 예측', 'WHO 프로그램', 'Hanen', 'ESDM', 'PACT', 'JASPER',
  'diagnosis', 'screening', 'risk', 'treatment', 'symptom', 'therapy', 'accuracy',
  'predict', 'prevent', 'borderline',
];
