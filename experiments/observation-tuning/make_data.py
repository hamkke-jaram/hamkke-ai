"""Make the observation claim trials. Every object, action and line here is newly authored."""
from __future__ import annotations
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent

# The four columns are visual evidence, a supported physical claim, a second supported
# description, and a plausible but unsupported physical claim. No playback/eval data is read.
TRAIN = """
아이가 혼자 종이띠 한쪽을 접는다.|아이의 손이 종이 끝을 반으로 접어요.|혼자 종이를 접어요.|아이와 어른이 종이를 나누어 접어요.
어른이 작은 천을 펴서 의자 위에 놓는다.|어른이 접혀 있던 천을 펼쳐요.|천이 의자 위에 놓여요.|어른이 천을 의자 아래로 던져요.
한 사람이 손목을 돌려 작은 뚜껑을 연다.|손목을 비틀어 뚜껑을 열어요.|혼자 뚜껑을 여는 모습이에요.|두 사람이 뚜껑을 번갈아 열어요.
아이가 줄자를 옆으로 밀고 옆 어른은 가만히 서 있다.|아이가 한쪽으로 줄자를 밀어요.|어른은 옆에 서 있어요.|두 사람이 같이 줄자로 놀아요.
두 아이가 마주 서서 원반을 번갈아 던지고 받아요.|아이 둘이 원반을 주고받아요.|두 사람이 함께 원반 던지기 놀이를 해요.|아이 혼자 원반을 계속 던져요.
아이가 바닥에 분필로 물결선을 긋고 어른은 창가에 선다.|아이가 구불구불한 선을 그려요.|어른이 창문 가까이에 서 있어요.|어른과 아이가 번갈아 물결선을 그려요.
두 사람이 바닥의 매트를 양끝에서 잡아 접는다.|두 사람이 매트의 끝을 잡아요.|두 사람이 함께 매트를 접어요.|두 사람이 매트로 시합을 해요.
한 사람이 테이블 위의 솔로 먼지를 쓸어요.|솔이 테이블 표면을 쓸고 지나가요.|사람이 혼자 솔을 움직여요.|두 사람이 솔을 서로 건네며 놀아요.
아이가 입술을 벌리고 팔을 어깨 높이로 든다.|팔이 어깨 근처까지 올라가요.|아이가 입을 벌려요.|아이가 입을 다물고 양팔을 내려요.
어른이 작은 깃발을 흔들며 한 걸음 뒤로 물러난다.|어른이 깃발을 흔들어요.|깃발을 든 사람이 뒤쪽으로 발을 옮겨요.|사람이 깃발을 내려놓아요.
아이가 주머니에서 작은 열쇠를 꺼내 선반에 놓는다.|아이가 열쇠를 꺼내요.|열쇠가 선반 위로 옮겨져요.|어른이 아이에게 열쇠를 건네요.
어른과 아이가 같은 방향을 보고 각자 모자를 고쳐 쓴다.|둘이 각자의 모자를 손으로 만져요.|어른과 아이가 같은 쪽을 봐요.|둘이 모자를 바꾸는 놀이를 해요.
두 사람이 줄넘기 줄 양끝을 돌리고 한 아이가 가운데에서 뛴다.|가운데 아이가 줄을 넘으며 뛰어요.|여럿이 함께 줄넘기를 해요.|아이가 혼자 줄 양끝을 돌려요.
한 아이가 양손으로 상자의 양옆을 눌러요.|아이가 상자 양쪽을 손으로 눌러요.|혼자 상자를 누르는 모습이에요.|다른 사람과 상자를 주고받아요.
어른은 옆에 앉아 책을 들고 있고 아이는 게시판을 가리킨다.|아이가 게시판 쪽으로 손가락을 뻗어요.|어른은 책을 들고 앉아 있어요.|어른과 아이가 게시판 맞히기 게임을 해요.
아이가 벽에 비친 자기 그림자를 따라 손바닥을 움직인다.|아이가 벽 앞에서 손바닥을 움직여요.|그림자가 아이 손을 따라 움직여요.|아이와 어른이 함께 그림자놀이를 해요.
두 사람이 같은 퍼즐판에 번갈아 조각을 끼운다.|차례로 같은 판에 조각을 맞춰요.|두 사람이 함께 퍼즐을 해요.|한 아이만 퍼즐을 맞추고 있어요.
어른이 손가락을 입술 앞에 세운 뒤 문 쪽을 향한다.|어른이 입술 앞으로 손가락을 들어요.|어른이 문을 향해 몸을 돌려요.|어른이 손가락을 무릎에 내려놓아요.
한 사람이 지퍼 손잡이를 맨 위까지 당긴다.|손이 지퍼를 위로 끌어올려요.|혼자 지퍼를 올려요.|어른과 아이가 지퍼를 번갈아 올려요.
아이가 마이크 윗부분을 손으로 가리킨다.|아이가 마이크를 가리켜요.|손가락이 마이크 쪽으로 향해요.|아이가 마이크를 바닥으로 내려놔요.
아이가 미끄럼틀 아래서 발을 구르고 어른은 떨어져 서 있다.|아이가 발을 바닥에 구르네요.|어른은 아이와 떨어져 있어요.|어른과 아이가 발 구르기를 번갈아 해요.
사람이 혼자 병풍처럼 접힌 지도를 펼친다.|사람이 접힌 지도를 펴요.|지도 모서리가 펴져요.|두 사람이 지도를 같이 접어요.
아이가 물감 롤러를 종이 위에서 한쪽으로 굴린다.|아이가 롤러를 종이 위로 밀어요.|혼자 롤러를 굴려요.|어른이 아이와 롤러를 번갈아 굴려요.
두 아이가 작은 수레 끈을 함께 잡고 한쪽으로 끈다.|두 아이가 같은 끈을 잡아요.|수레를 둘이 함께 당겨요.|한 아이만 줄을 잡고 다른 아이는 보고 있어요.
""".strip()

# Held-out situations are fixed independently of the run and of all clinical/COCO examples.
HELD = """
아이가 혼자 우산의 손잡이를 잡아 비스듬히 기울인다.|아이가 우산을 옆으로 기울여요.|우산 손잡이를 쥔 손이 보여요.|어른이 우산을 아이와 주고받아요.
한 사람이 문고리를 아래로 누른 뒤 문을 앞으로 민다.|문고리가 아래로 내려가요.|사람이 문을 밀어 열어요.|두 사람이 함께 문을 잡아당겨요.
어른은 벤치에 앉아 있고 아이만 연의 얼레를 감는다.|아이 손에서 얼레가 돌아가요.|어른이 벤치에 앉아 있어요.|어른과 아이가 번갈아 얼레를 감아요.
두 사람이 셔틀콕을 라켓으로 번갈아 친다.|두 사람이 셔틀콕을 주고받아요.|둘이 함께 배드민턴을 치고 있어요.|한 명이 혼자 셔틀콕을 띄워요.
아이 둘이 식탁 양끝에서 한 장의 식탁보를 펴서 덮는다.|두 아이가 식탁보를 함께 펼쳐요.|둘이 천의 끝을 잡아요.|두 아이가 식탁보로 시합해요.
어른은 맞은편에서 손을 무릎에 올린 채 있고 아이는 혼자 도장을 뚜껑에 맞춘다.|아이가 도장을 뚜껑에 맞춰요.|맞은편 어른은 손을 무릎에 두었어요.|둘이 도장을 번갈아 쥐고 놀아요.
아이는 손바닥으로 귀를 가린 뒤 몸을 옆으로 돌린다.|아이가 양손으로 귀를 덮어요.|아이가 몸의 방향을 바꿔요.|아이가 양손을 등 뒤로 돌려요.
두 사람이 체스판 양쪽에 앉아 차례로 말을 옮긴다.|둘이 번갈아 체스 말을 움직여요.|두 사람이 같이 체스를 해요.|혼자 체스판을 접어요.
한 아이가 전등 스위치를 누르며 입술을 움직인다.|아이가 전등 스위치에 손을 대요.|아이의 입술이 움직여요.|불이 꺼지자 어른이 스위치를 눌러요.
한 사람이 빗자루 끝으로 바닥의 종이 조각을 모은다.|사람이 종이를 한곳에 쓸어 모아요.|빗자루 끝이 바닥을 지나가요.|둘이 번갈아 빗자루로 놀아요.
아이가 신발 끈 끝을 모아 쥐고 어른은 옆에서 외투를 벗는다.|아이가 신발 끈을 손에 모아요.|어른이 옆에서 겉옷을 벗어요.|어른과 아이가 함께 끈 묶기 놀이를 해요.
두 사람이 볼링 핀을 세운 뒤 공을 교대로 굴린다.|둘이 차례를 바꿔 가며 공을 굴려요.|두 사람이 같이 볼링을 해요.|각자 따로 앉아서 공을 바라봐요.
""".strip()

TRAIN_SPEECH = ['상대에게 잘했다고 칭찬해요.', '방법을 이야기해 줘요.', '상대에게 이름을 물어봐요.', '무엇을 하는지 말로 설명해요.', '다른 사람의 말에 대답해요.', '다시 해 보라고 말을 걸어요.']
HELD_SPEECH = ['지금 하자는 제안을 말로 건네요.', '왜 그러는지 묻고 있어요.', '괜찮다고 대답해요.', '방법을 소리 내어 알려 줘요.']

def authored(source, speech, prefix):
    rows = []
    for index, line in enumerate(source.splitlines(), 1):
        evidence, first, second, unsupported = line.split('|')
        group = f'{prefix}-{index:02d}'
        for action, keep, kind in [(first, True, 'visible'), (second, True, 'visible'),
                                   (unsupported, False, 'unseen_or_wrong_participants'),
                                   (speech[(index-1)%len(speech)], False, 'unheard_speech')]:
            rows.append(dict(group=group, evidence=evidence, claim=action, keep=keep, kind=kind))
    return rows

def save(file, rows):
    # Preserve the bytes of the original training run, including its Windows line endings.
    file.write_bytes(''.join(json.dumps(x, ensure_ascii=False)+'\r\n' for x in rows).encode('utf-8'))

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def main():
    held = authored(HELD, HELD_SPEECH, 'reserved')
    train = authored(TRAIN, TRAIN_SPEECH, 'authored')
    source = ROOT/'public-data/train-source.jsonl'
    public = [json.loads(line) for line in source.read_text(encoding='utf-8-sig').splitlines() if line.strip()]
    assert len({r['sourceId'] for r in public})==len(public)>0
    for i,row in enumerate(public):
        claim = row['action'].strip()
        group = 'coco-'+str(row['sourceId'])
        # Affirmatives retain the attributed human-action caption. The contrast is separately
        # authored and concerns speech a still image cannot support; it is not a COCO label.
        train.extend([dict(group=group,evidence=claim,claim=claim,keep=True,kind='coco_visible'),
                      dict(group=group,evidence=claim,claim=TRAIN_SPEECH[i%len(TRAIN_SPEECH)],
                           keep=False,kind='unheard_speech')])
    assert not ({r['group'] for r in train}&{r['group'] for r in held})
    assert not ({r['claim'] for r in train}&{r['claim'] for r in held})
    save(ROOT/'train.jsonl',train)
    save(ROOT/'heldout.jsonl',held)
    lock=dict(train=len(train), heldout=len(held), publicSourceCount=len(public),
              authoredTrainScenes=len(TRAIN.splitlines()),authoredHeldoutScenes=len(HELD.splitlines()),
              sourceSha256=sha(source),trainSha256=sha(ROOT/'train.jsonl'), heldoutSha256=sha(ROOT/'heldout.jsonl'))
    (ROOT/'data-lock.json').write_text(json.dumps(lock,indent=2)+'\n',encoding='utf-8')
    print(lock)

if __name__=='__main__':
    main()
