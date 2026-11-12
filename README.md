# hamkke-ai — 기기 내 상호작용 분석

함께자람의 AI 파트 저장소. 부모 폰 브라우저 안에서 영상 1개를 분석해 **지표 3개**(함께 노는 시간, 부모 반응 시간, 울음·감정 폭발 횟수)를 계산하는 패키지 `@hamkke-jaram/analysis`와, 연출 영상으로 결과를 확인하는 **로컬 평가 페이지**가 있다.

- 지표 정의(파트 간 약속): [docs/metrics.md](docs/metrics.md)
- 원본 영상·음성은 기기 밖으로 나가지 않는다. 서버 없음. 결과는 숫자만.
- 의료 서비스나 아이 평가를 표방하지 않는다. 금지 표현은 `scripts/check-expressions.mjs`가 검수한다.

## 구성

| 경로 | 내용 |
|---|---|
| `src/audio.ts` | 오디오: 소리 구간·음높이 → 아이/어른 구분(추정) → 반응 시간, 울음 횟수 |
| `src/pose.ts` | 자세 랜드마크 → 두 사람이 가까이 있는 시간 |
| `src/analyzeVideo.ts` | 영상 파일 → MediaPipe Pose(WASM) + 오디오 디코딩 → `DeviceMetrics` |
| `eval/` | 로컬 평가 페이지(여러 영상 일괄 분석, 사람이 잰 값과 비교, CSV) |
| `scripts/prepare-models.mjs` | MediaPipe WASM·모델을 앱의 `public/mediapipe`에 준비 |

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
npm test            # 합성 신호로 지표 계산 검증
npm run typecheck
npm run eval        # http://localhost:5173 — 로컬 평가 페이지
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
