# VL 관찰 기록 평가 도구 (`server/eval/`)

hamkke-api `docs/ai-observation.md` 10장의 열린 항목 "VL이 쓴 문장의 품질을 사람이 본 것과 비교"를 위한 도구다.
사람이 장면 사진에 붙인 태그(라벨)와 모델이 붙인 태그를 비교해 **일치·놓침·더함 수**를 세고, 모델이 쓴 글이 문장 검사에 얼마나 걸리는지 센다.

- 서버와 같은 코드로 초안과 전체 장면을 확인한다. 공동놀이 또는 여러 행위자가 등장하는 경우에는 첫·가운데·마지막 사진을 독립적으로 점검한다. 같은 사진의 독립 CPU 인물 검출 결과도 적용한다. 무음 입력에서 대화가 포함된 문장은 시각 행동 절을 복원한 뒤 평가한다. 초안과 점검에 같은 요청 제한시간을 적용하고 재시도는 최대 한 번이다.
- 버전 `obs-v6.3-preserved`는 `obs-v6.2-witnessbox`와 모델 요청 문구, 사진 선택, CPU 모델 파일이 같다. 같은 모델 원응답을 재생해 보정 규칙의 효과를 확인할 수 있다. 새로 생성했을 때의 성능은 전체 추론을 별도로 실행해 측정한다.
- `obs-v6.3.1-preserved`는 같은 요청과 검출 결과를 사용하고 최종 반환 직전에 `server/src/presence.ts`의 `reconcilePresence(observation, originalNormalisedDraft)`를 적용한다. 이전 버전에서 저장한 반환값과 같은 초안으로 이 마지막 변화를 그대로 재현할 수 있다.
- 서버를 띄우지 않고 모델 제공자를 직접 부른다(토큰·영수증 없음). 환경 변수는 서버와 같다: `OLLAMA_URL`, `VL_MODEL`, `VL_FALLBACK_MODEL`, `OLLAMA_AUTH_TOKEN`, `VL_TIMEOUT_MS`, `VL_NUM_CTX` …
- 결과(화면·CSV)에는 **태그 이름과 숫자만** 남는다. 사진과 관찰 문장은 저장하지 않는다. 사람이 문장을 직접 읽어 비교하려면 `--show-text`를 붙인다(화면에만 보이고 CSV 에는 들어가지 않는다).
- 결과는 내부 개선용이다. 앱·발표 자료에 퍼센트 수치로 옮기지 않는다.

## 1. 사진 준비 (커밋하지 않는다)

**실제 아이 사진은 저장소에 넣지 않는다.** 팀원이 연출했거나 촬영·평가 사용에 동의를 받은 영상만 쓴다.
`server/eval/frames/` 와 `server/eval/vl-labels.json` 은 `.gitignore` 에 들어 있다.

웹과 같은 조건(긴 변 512px, JPEG)으로 10초마다 한 장씩 뽑는 예:

```bash
mkdir -p server/eval/frames/staged-01-blocks
ffmpeg -i staged-01.mp4 -vf "fps=1/10,scale='if(gt(iw,ih),512,-2)':'if(gt(iw,ih),-2,512)'" -frames:v 6 -q:v 5 \
  server/eval/frames/staged-01-blocks/%02d.jpg
```

`%02d` 번째 사진의 시각은 `(번호 - 1) × 10`초다(01 → 0초, 02 → 10초 …). 한 장은 300KB 이하, 한 변 16~2048px 여야 한다(서버와 같은 검사).

## 2. 라벨 파일

`vl-labels.example.json` 을 `vl-labels.json` 으로 복사해 채운다. 경로(`file`)는 라벨 파일이 있는 폴더 기준이다.

```json
{
  "clips": [
    {
      "id": "staged-01-blocks",
      "durationSec": 60,
      "frames": [{ "t": 0, "file": "frames/staged-01-blocks/01.jpg" }],
      "expected": {
        "childStates": ["PLAYING_TOGETHER", "REFUSING"],
        "adultResponses": ["WAITING"],
        "peopleCount": 2
      }
    }
  ]
}
```

| 필드 | 규칙 |
|---|---|
| `id` | 영문·숫자·`.-_`, 64자 이하, 겹치지 않게 |
| `durationSec` | 영상 길이(초). 모르면 빼거나 `null` |
| `frames` | 1~6장. `t`(초)와 `file` |
| `expected.childStates`, `expected.adultResponses` | 사진에서 **분명히 보이는** 태그만(`docs/observation.md` 5장 목록). 목록에 없는 값이면 시작하기 전에 알려 준다 |
| `expected.peopleCount` | 0~3 (3은 '3명 이상'). 없으면 사람 수는 비교하지 않는다 |

라벨은 두 사람이 따로 붙인 뒤 맞춰 보는 것이 좋다. 애매한 태그는 넣지 않는다. 사진만 입력하는 관찰에서는 대화를 확인할 수 없으며 최종 기록의 `TALKING`은 항상 비운다.

## 3. 실행

```bash
ollama pull qwen3.5:4b
npm run eval:vl -- --labels server/eval/vl-labels.json --csv vl-eval.csv
# 한 클립만:      npm run eval:vl -- --only staged-01-blocks
# 문장도 보기:    npm run eval:vl -- --show-text
```

화면 예:

```
클립                      결과                  시도  걸린 시간  아이 태그  어른 태그  사람 수         글  모델
staged-01-blocks          ok                     1     41.2s     1/1/0     2/0/1     2/2      0/0/3  qwen3.5:4b
...
아이 모습: 일치 7, 놓침 3, 더함 2 (precision 0.78, recall 0.70)
```

- **태그 칸**: 일치/놓침/더함. 일치 = 사람과 모델이 모두 붙임, 놓침 = 사람만 붙임, 더함 = 모델만 붙임.
- **precision** = 일치 ÷ (일치 + 더함): 모델이 붙인 태그 가운데 사람 라벨과 같은 몫. **recall** = 일치 ÷ (일치 + 놓침): 사람 라벨 가운데 모델도 붙인 몫. 모델 출력을 얻은 클립(`ok`)만 센다.
- **글 칸**: 문장 검사에 걸림/최종 기록에서 빠짐/모델이 쓴 글 수(`summary` + `note`). 빠짐에는 문장 검사 말고도 해요체가 아니거나 한국어가 아닌 글이 들어간다.
- **결과**: `ok`, `bad_output`(두 번 모두 쓸 수 없는 출력), `timeout`, `unavailable:<코드>`, `invalid_frames:<코드>`, `missing_files`.
- **모델**: 기록을 쓴 모델. `VL_FALLBACK_MODEL` 로 넘어갔으면 그 이름이 보인다.

CSV 열: `clip, outcome, attempts, ms, model, child_matched, child_missed, child_extra, adult_matched, adult_missed, adult_extra, missed_tags, extra_tags, people_expected, people_got, texts_written, texts_wording_rejected, texts_dropped, invalid_tags`.

## 4. 볼 것

- 프롬프트(`obs-v2` → `obs-v3`)나 모델을 바꾸기 전후에 같은 라벨로 돌려 **놓침·더함이 어느 태그에서 늘었는지** 본다(`missed_tags`, `extra_tags`).
- `texts_wording_rejected` 가 자주 나오면 프롬프트 규칙을 고칠 신호다(서버는 그 글을 버리므로 사용자에게는 보이지 않는다).
- 계산 부분은 `harness.ts` 에 있고 `server/test/vl-eval.test.ts` 가 가짜 제공자로 확인한다.

## 5. 엣지 케이스·품질 시험 (`edge.ts`)

사람 라벨 없이 **깨지는 곳**을 찾는 시험이다. 사람 사진은 쓰지 않는다. 결과에는 갈래 이름·상태 코드·숫자만 남는다.

```bash
node server/eval/make-edge-scenes.mjs        # 합성 장면 → server/eval/frames/edge/, 입력 낱장 → server/eval/frames/edge-inputs/ (ffmpeg 필요)
node server/eval/edge.ts scenes --runs 5 [--only text-heavy,injection] [--frames 3] [--long-edge 384] [--retry-hint] [--csv out.csv]
node server/eval/edge.ts inputs --server http://127.0.0.1:18090 [--model-cases]   # 이상한 입력을 실제 서버에 보낸다
node server/eval/edge.ts load --server http://127.0.0.1:18090 --concurrency 5      # 동시 요청(대기열·429)
```

- **장면**: 테스트 무늬, 글자가 많은 사진, 사진 안 글귀로 지시를 넣은 것, 캐릭터·코칭 그림(`hamkke-web/public`), 흐린·세로·같은 사진 6장, 검은·흰·잡음 사진.
- `scenes` 는 서버와 같은 순서(사진 검사 → 초안 작성·다듬기 → 무음 사진으로 호칭·놀이 점검)로 모델을 직접 부른다. 요청마다 사진 귀퉁이 2×2 픽셀을 바꿔 새 사진으로 보낸다(같은 사진을 다시 보내면 Ollama 가 앞서 읽은 결과를 재사용해 실제보다 빠르게 나온다. `--reuse` 로 끌 수 있다).
- 토큰 수는 초안 모델의 응답에서 가져오고 총 소요 시간은 점검 호출까지 포함한다.
- 장면 줄: `ok n/N`, `bad`(두 번 모두 쓸 수 없음 = 서버라면 502), `retry 다시 부름(+살아남)`, 걸린 시간 중앙값/최댓값, `drop 빠진 글/쓴 글`, 사람 수 분포, 빠진 까닭(`wording:<갈래>`, `not_haeyo`, `not_korean` …).
- 갈래 이름은 `wording.ts` 목록 이름에서 `_PATTERNS` 를 뗀 것이다(`READING` = 사진 속 글자 옮겨 적기, `INNER_STATE` = 짐작하는 말투 …). 갈래 가르기는 `edge-lib.ts`, 확인은 `server/test/edge-lib.test.ts`(예문 파일 전체로 `passesWordingCheck` 와 같은지 본다).
- `inputs`·`load` 는 개발용 비밀(또는 `AI_SHARED_SECRET`)로 분석 토큰을 만든다. 8090 이 아닌 포트에 띄운 서버에 쓴다.
- 기기 내 분석 엣지 케이스는 `node scripts/edge-videos.mjs` 로 합성 영상을 만든 뒤 평가 페이지 `eval/edge-videos.html` 에서 돌린다.
