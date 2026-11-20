-- Korean editorial summaries of specific sections, verified 2026-11-20.
-- Only public reference material belongs here. An age range is in completed months.
CREATE TABLE passage (
  id TEXT PRIMARY KEY, topic TEXT NOT NULL, minAge INTEGER NOT NULL, maxAge INTEGER,
  title TEXT NOT NULL, publisher TEXT NOT NULL, url TEXT NOT NULL, section TEXT NOT NULL,
  keywords TEXT NOT NULL, passage TEXT NOT NULL, action TEXT NOT NULL, reason TEXT NOT NULL
);
INSERT INTO passage VALUES
('NURI-OBSERVE-PLAY','explore',36,71,
 '2019 개정 누리과정 놀이실행자료','교육부·보건복지부','https://i-nuri.go.kr/teacher/board/view.do?board_idx=376&manage_idx=25&menu_idx=19',
 '「놀이지원을 위해 관찰한다」, 45–46쪽 (3–5세)',
 '혼자 스스로 반복 블록 블럭 장난감 놀잇감 놀이 쌓 포개 끼우 만지 굴리 탐색 조작',
 '교사는 유아가 자료와 공간을 어떻게 사용하는지 관찰하면서 놀이의 의미와 필요한 지원을 살핀다.',
 '아이가 고른 놀이를 잠시 지켜보세요. 어떤 물건과 움직임을 반복하는지 살핀 뒤 도움을 요청하거나 놀이가 멈출 때 곁에서 반응해 주세요.',
 '놀이를 이끄는 아이의 행동을 먼저 관찰하면 무엇에 관심을 두는지 보고 개입할 시점을 정할 수 있어요.'),
('CDC-PLAY-DESCRIBE','explore',24,59,
 'Tips for Connecting and Communicating','미국 CDC','https://www.cdc.gov/parenting-toddlers/communication/',
 'Imitate and describe (2–4세)',
 '놀이 블록 블럭 인형 자동차 공 장난감 놀잇감 쌓 포개 끼우 굴리 만지 흔들 놓',
 '놀이 중 아이의 행동을 구체적인 말로 묘사하면 어른이 관심을 보이고 있으며 행동에 해당하는 단어를 들려줄 수 있다.',
 '아이의 놀이를 잠시 보고 방금 한 움직임 한 가지를 짧게 말해 주세요. 다음에는 아이가 무엇을 하는지 기다려 보세요.',
 '아이가 이미 하고 있는 행동을 말로 짚어 주면 그 행동을 가리키는 말을 들려주면서 관심을 표현할 수 있어요.'),
('HARVARD-NAME-WAIT','gesture',0,NULL,
 '5 Steps for Brain-Building Serve and Return','하버드대학교 아동발달센터','https://developingchild.harvard.edu/wp-content/uploads/2024/10/HCDC_ServeReturn_for_Parents_Caregivers_2019.pdf',
 '2쪽, 3단계 이름 붙이기와 4단계 차례 기다리기 (영유아)',
 '가리 가리켜 손짓 손가락 검지 손을 뻗 손길 쪽 물건 대상 그림',
 '아이가 가리키거나 바라보는 대상에 이름을 붙여 반응한다. 어른이 반응한 다음에는 아이가 다시 표현할 시간을 준다.',
 '아이가 손으로 가리키거나 손을 뻗은 쪽을 함께 보세요. 무엇인지 확인되면 이름을 한 번 말하고 아이가 다시 표현할 시간을 주세요.',
 '관심을 보인 대상과 그 이름을 연결할 수 있고, 잠시 기다리면 아이가 자기 방식으로 다음 차례에 참여할 여유가 생겨요.'),
('HARVARD-TAKE-TURNS','exchange',0,NULL,
 '5 Steps for Brain-Building Serve and Return','하버드대학교 아동발달센터','https://developingchild.harvard.edu/wp-content/uploads/2024/10/HCDC_ServeReturn_for_Parents_Caregivers_2019.pdf',
 '2쪽, 4단계 차례를 주고받고 기다리기 (영유아)',
 '건네 건넨 건넸 주고받 주고 받 번갈 차례 굴려 물건 공 장난감 블록',
 '아이가 보낸 신호에 반응한 다음에는 자신의 반응을 준비할 시간을 주며 차례를 주고받는다.',
 '아이가 물건을 건네거나 차례를 주고받으면 한 번 받아 반응해 주세요. 다시 건네거나 손짓할 때까지 잠시 기다려 보세요.',
 '아이의 차례 사이에 여유를 두면 어른이 계속 이끌지 않아도 아이가 다음 행동을 선택할 수 있어요.'),
('HARVARD-CHANGE-PLAY','switch',0,NULL,
 '5 Steps for Brain-Building Serve and Return','하버드대학교 아동발달센터','https://developingchild.harvard.edu/wp-content/uploads/2024/10/HCDC_ServeReturn_for_Parents_Caregivers_2019.pdf',
 '2쪽, 5단계 활동의 끝과 시작 알아차리기 (영유아)',
 '내려놓 내려놓고 다른 바꾸 옮겨 새 장난감 놀잇감 놀이 집어',
 '아이가 하던 놀이를 놓고 다른 대상에 관심을 돌리는 모습을 살펴 활동을 마치거나 새로 시작할 시점을 알아본다.',
 '하던 놀이를 잠시 멈추고 아이가 새로 고른 쪽을 함께 살펴보세요. 이전 놀이로 돌아오라고 재촉하지 않고 다음 선택을 기다려 보세요.',
 '물건을 바꾸거나 다른 쪽으로 향하는 행동을 살피면 아이가 활동의 끝과 시작을 이끌 기회를 줄 수 있어요.'),
('CDC-TIME-IN','cry',24,59,
 'How to Use Time-In','미국 CDC','https://www.cdc.gov/parenting-toddlers/responding-to-behavior/time-in.html',
 'Overview 및 3단계 Cool down and offer support (2–4세)',
 '울고 울음 울었 울어요 눈물 흐느끼 흐느껴 울기',
 '아이가 힘들어할 때는 신체적으로 불편한 부분이 있는지 먼저 확인한다. 차분하게 곁을 지키며 안정할 수 있도록 돕는다.',
 '아이가 울 때는 다치거나 불편한 곳이 있는지 먼저 살펴주세요. 괜찮다면 가까운 곳에 차분히 머무르며 아이가 원하는 만큼 시간을 주세요.',
 '울음의 원인을 장면만으로 정하기는 어려워요. 먼저 불편함을 살핀 뒤 곁에 있는 것은 아이가 도움을 받을 수 있음을 전하는 방법이에요.'),
('AAP-BOOK-PICTURES','book',36,47,
 'How to Share Books with Children 2 and 3 Years Old','미국소아과학회(AAP)','https://www.healthychildren.org/English/ages-stages/toddler/Pages/How-to-Share-Books-with-2-and-3-Year-Olds.aspx',
 'Your 3-year-old / What parents can do (3세)',
 '그림책 책장 책을 페이지 그림 넘겨 넘기 펼쳐 펼치 바라봐',
 '조용하고 편안한 곳에서 아이와 책을 보고, 그림에 관해 아이가 보여 주거나 이야기하는 것에 반응한다.',
 '아이가 머무는 책장을 함께 보세요. 아이가 가리키는 그림이나 하는 말에 반응하고 그 장면을 조금 더 살펴보세요.',
 '아이가 보고 있는 그림은 책을 함께 보며 반응을 주고받을 수 있는 구체적인 소재가 돼요.');
CREATE TABLE source_document (
  source_key TEXT PRIMARY KEY, title TEXT NOT NULL, publisher TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE, license TEXT NOT NULL, license_url TEXT NOT NULL,
  asset TEXT NOT NULL, sha256 TEXT NOT NULL, body TEXT NOT NULL,
  acquired_on TEXT NOT NULL, acquisition TEXT NOT NULL
);
CREATE TABLE passage_provenance (
  passage_id TEXT PRIMARY KEY REFERENCES passage(id),
  source_key TEXT NOT NULL REFERENCES source_document(source_key), anchor TEXT NOT NULL
);
CREATE VIRTUAL TABLE evidence_search USING fts5(keywords, passage, anchor, tokenize='unicode61');
CREATE TABLE metadata(version TEXT NOT NULL);
INSERT INTO metadata VALUES ('care-2026-11-20.2');
