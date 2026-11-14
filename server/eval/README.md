# VL 관찰 기록 평가 도구 (`server/eval/`)

hamkke-api `docs/ai-observation.md` 10장의 열린 항목 "VL이 쓴 문장의 품질을 사람이 본 것과 비교"를 위한 도구다.
사람이 장면 사진에 붙인 태그(라벨)와 모델이 붙인 태그를 비교해 **일치·놓침·더함 수**를 세고, 모델이 쓴 글이 문장 검사에 얼마나 걸리는지 센다.

- 서버와 **같은 코드**로 처리한다: 사진 검사(`frames.ts`) → 프롬프트 `obs-v1`(`prompt.ts`) → 모델 호출(최대 2번) → 해석·다듬기(`observation.ts`) → 문장 검사(`wording.ts`).
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
        "adultResponses": ["WAITING", "TALKING"],
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

라벨은 두 사람이 따로 붙인 뒤 맞춰 보는 것이 좋다. 애매한 태그는 넣지 않는다(프롬프트도 애매하면 고르지 말라고 한다).

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

- 프롬프트(`obs-v1` → `obs-v2`)나 모델을 바꾸기 전후에 같은 라벨로 돌려 **놓침·더함이 어느 태그에서 늘었는지** 본다(`missed_tags`, `extra_tags`).
- `texts_wording_rejected` 가 자주 나오면 프롬프트 규칙을 고칠 신호다(서버는 그 글을 버리므로 사용자에게는 보이지 않는다).
- 계산 부분은 `harness.ts` 에 있고 `server/test/vl-eval.test.ts` 가 가짜 제공자로 확인한다.
