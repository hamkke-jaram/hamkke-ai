# hamkke-ai — 기기 내 상호작용 분석 + AI 관찰 기록 서버

함께자람의 AI 파트 저장소. 두 가지가 들어 있다.

1. **기기 내 분석 패키지** `@hamkke-jaram/analysis` — 부모 폰 브라우저 안에서 영상 1개를 분석해 **지표 3개**(함께 노는 시간, 부모 반응 시간, 울음·감정 폭발 횟수)를 계산한다. 연출 영상으로 결과를 확인하는 **로컬 평가 페이지**가 함께 있다.
2. **AI 관찰 기록 서버** `server/` — 보호자가 동의한 아이에 한해 웹이 보낸 **장면 사진 최대 6장**을 VL 모델에 보여 주고, 본 것을 짧게 적은 관찰 기록과 서명한 영수증을 돌려준다.

- 지표 정의(파트 간 약속): [docs/metrics.md](docs/metrics.md)
- AI 관찰 기록 서버(받는 것, 돌려주는 것, 띄우는 법): [docs/observation.md](docs/observation.md)
- 영상 원본과 소리는 기기 밖으로 나가지 않는다. 지표 3개는 기기 안에서 숫자로만 계산한다. AI 서버로 가는 것은 장면 사진뿐이고, 서버는 사진을 메모리에서만 다루며 저장하지도 로그에 남기지도 않는다.
- 의료 서비스나 아이 평가를 표방하지 않는다. VL 모델은 본 것을 적기만 하고 조언 문장을 만들지 않는다. 금지 표현은 `scripts/check-expressions.mjs`가 검수한다.

## 구성

| 경로 | 내용 |
|---|---|
| `src/audio.ts` | 오디오: 소리 구간·음높이 → 아이/어른 구분(추정) → 반응 시간, 울음 횟수 |
| `src/pose.ts` | 자세 랜드마크 → 두 사람이 가까이 있는 시간 |
| `src/analyzeVideo.ts` | 영상 파일 → MediaPipe Pose(WASM) + 오디오 디코딩 → `DeviceMetrics` |
| `eval/` | 로컬 평가 페이지(여러 영상 일괄 분석, 사람이 잰 값과 비교, CSV) |
| `scripts/prepare-models.mjs` | MediaPipe WASM·모델을 앱의 `public/mediapipe`에 준비 |
| `server/src/` | AI 관찰 기록 서버(Node 24, npm 실행 의존성 없음). `app.ts` 요청 처리, `jwt.ts` 토큰·영수증, `frames.ts` 사진 검사, `observation.ts` 출력 검사, `prompt.ts` 프롬프트 `obs-v1`, `ollama.ts` 모델 제공자 |
| `server/test/` | 서버 테스트(가짜 제공자, 네트워크·모델 없음) |
| `server/Dockerfile` | 서버 이미지(빌드 문맥은 저장소 루트) |

## AI 관찰 기록 서버 (`server/`)

```bash
ollama pull qwen3.5:4b     # 한 번만. 사진을 볼 수 있는 모델
npm run server             # node server/src/index.ts → http://127.0.0.1:8090
curl http://127.0.0.1:8090/ai/v1/health
```

- `POST /ai/v1/analyze` — hamkke-api 가 발급한 분석 토큰(Bearer)과 JPEG 사진 1~6장을 받아 `{ observation, receipt, modelVersion, promptVersion, analyzedFrames }` 를 돌려준다. 웹은 영수증을 hamkke-api 에 내서 저장한다.
- `GET /ai/v1/health` — `{ status, model, modelReady }`.
- 환경 변수: `PORT`(8090), `AI_SHARED_SECRET`(hamkke-api 와 같은 값, production 에서는 필수), `OLLAMA_URL`, `VL_MODEL`(qwen3.5:4b), `VL_MAX_CONCURRENCY`(1), `VL_MAX_WAITING`(2), `VL_TIMEOUT_MS`(180000), `VL_KEEP_ALIVE`.
- 컨테이너: `docker build -f server/Dockerfile -t hamkke-ai .`
- 제한, 오류 코드, 태그 목록, 문장 검사, 다른 모델 제공자를 붙이는 법은 [docs/observation.md](docs/observation.md)에 있다. 세 저장소 공통 약속은 hamkke-api 의 `docs/ai-observation.md` 다.

GPU 가 없는 기기에서는 느리다(개발 기기 CPU 로 사진 6장에 1분쯤). 배포할 때는 GPU 가 있는 기기에서 Ollama 를 돌리거나 다른 제공자를 붙인다.

## 앱에서 쓰기 (hamkke-web)

```jsonc
// package.json
"dependencies": {
  "@hamkke-jaram/analysis": "https://github.com/hamkke-jaram/hamkke-ai/archive/refs/tags/v0.1.1.tar.gz",
  "@mediapipe/tasks-vision": "0.10.35"
}
```

```ts
import { analyzeVideo, SPEC_VERSION, MODEL_VERSION } from '@hamkke-jaram/analysis';
const metrics = await analyzeVideo(file, (stage, ratio) => {}, { runAudio: runAudioInWorker });
```

앱은 `/mediapipe/wasm`, `/mediapipe/models/pose_landmarker_lite.task`를 제공해야 한다:
`node node_modules/@hamkke-jaram/analysis/scripts/prepare-models.mjs public`

## 개발

```bash
npm install
npm test            # 합성 신호로 지표 계산 검증 + AI 서버 테스트
npm run typecheck   # 분석 패키지 + server/
npm run eval        # http://localhost:5173 — 로컬 평가 페이지
npm run server      # http://127.0.0.1:8090 — AI 관찰 기록 서버 (Node 24, Ollama 필요)
```

### 로컬 평가

1. 팀원이 연출했거나 동의를 받은 영상을 `eval/videos/`(깃 제외)에 둔다. **영상은 커밋하지 않는다.**
2. 스톱워치로 잰 값을 `labels.json`으로 적는다(`eval/labels.example.json` 참고).
3. `npm run eval` → 영상들과 라벨 파일 선택 → 분석 시작 → 차이 표와 CSV.

평가 결과는 내부 개선용이다. 앱·발표 자료에 "○○% 맞음" 같은 퍼센트 수치로 쓰지 않는다.

## 릴리스

계산 방법을 바꾸면 `docs/metrics.md`와 `specVersion`을 함께 올리고(백엔드 지원 목록도 갱신), 태그를 단다.

```bash
npm version patch && git push --follow-tags   # 버그 수정 (예: 0.1.0 → 0.1.1)
npm version minor && git push --follow-tags   # 계산 방법·기능이 바뀔 때 (예: 0.1.1 → 0.2.0)
```

`npm version`이 `package.json`과 `package-lock.json`의 버전을 함께 올리고 태그를 단다.
웹은 `package.json`의 tarball 주소(`.../archive/refs/tags/vX.Y.Z.tar.gz`)에서 버전을 올린 뒤
`npm install`로 반영한다.
