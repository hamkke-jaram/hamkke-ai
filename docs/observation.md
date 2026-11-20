# AI 관찰 기록 서버 (hamkke-ai `server/`)

세 저장소가 함께 지키는 약속은 hamkke-api 의 `docs/ai-observation.md` 다. 이 문서는 그 가운데 **AI 서버 쪽**을 적는다:
무엇을 받고 무엇을 돌려주는지, 어떻게 띄우는지, 모델을 어떻게 바꾸는지.

- 영수증 버전: 기본 `obs-v6.9-ear-timing`, 7장 이상으로 구간을 분석하면 `obs-v6.9-windowed`
- v1 모델: Ollama `qwen3.5:4b` (사진을 볼 수 있는 모델, 생각 단계는 끄고 부른다)
- 의료 서비스가 아니고 아이를 평가하지 않는다. VL 모델은 **본 것을 적기만** 하고 조언 문장을 만들지 않는다.

## 1. 하는 일

```
[웹] 장면 사진 + 분석 토큰 (기본 6장, 가정에서 이번 영상에 허용한 경우 최대 24장, JPEG, 소리 없음)
   → POST /ai/v1/analyze
        1) 토큰 확인(HS256, iss/aud/만료/필수 클레임, 한 번만 쓰는 jti)
        2) 본문·사진 검사(크기, 장수, JPEG 여부)
        3) 대기열 → Ollama 초안 → 태그·문장 검사 → 같은 사진으로 시각 점검
        4) 관찰 기록 + 서명한 영수증(JWS) 응답
   → 웹이 영수증을 hamkke-api 에 내면 저장된다
```

- 사진은 **메모리에서만** 다룬다. 디스크에 쓰지 않고, 로그에도 남기지 않는다. 검사용으로 디코딩한 바이트는 검사 직후 0으로 덮고, 모델 호출이 끝나면 사진을 가리키는 참조를 모두 놓는다.
- 모델 서버로 넘기기 전에 JPEG 의 메타데이터 구획(APP1~APP15: EXIF 위치·촬영 기기·썸네일 등, 주석)을 뺀다. 그림 자료는 그대로다. 웹이 만든 사진에는 원래 없고, 다른 클라이언트가 보낸 위치 정보가 모델 서버로 가지 않게 하려는 것이다.
- hamkke-api 는 사진을 받지 않는다. 이 서버가 돌려준 영수증(글자)만 받는다.
- CORS 헤더를 내지 않는다. 웹은 같은 출처의 `/ai/` 프록시(nginx·vite)로 부른다.

## 2. 띄우기

Node 24 가 TypeScript 를 바로 실행한다(빌드 없음, npm 실행 의존성 없음).

```bash
ollama pull qwen3.5:4b          # 한 번만
npm run server                  # = node server/src/index.ts  → http://127.0.0.1:8090
curl http://127.0.0.1:8090/ai/v1/health
# {"status":"ok","model":"qwen3.5:4b","modelReady":true}
```

컨테이너(빌드 문맥은 저장소 루트):

```bash
docker build -f server/Dockerfile -t hamkke-ai .
docker run --rm -p 8090:8090 -e AI_SHARED_SECRET=... -e OLLAMA_URL=http://ollama:11434 hamkke-ai
```

컨테이너의 `HEALTHCHECK` 는 **서버가 살아 있는지**만 본다(`/ai/v1/health`, 언제나 200). 모델이 준비되지 않았다고 컨테이너를 다시 켜도 나아지지 않고, 그 사이 들어온 요청까지 끊기기 때문이다. 모델 준비 여부는 바깥 가동 감시에서 `/ai/v1/health?strict=1`(준비 안 됨 → 503)이나 지표의 `hamkke_ai_model_ready` 로 따로 본다(3장).

### 환경 변수

| 이름 | 기본값 | 뜻 |
|---|---|---|
| `NODE_ENV` | (없음) | `production` 이면 비밀이 꼭 있어야 하고, 받는 주소가 `0.0.0.0` 이 되고, 바깥 주소로 가는 평문 http 를 막는다 |
| `PORT` | `8090` | 받는 포트 |
| `HOST` | 개발 `127.0.0.1`, production `0.0.0.0` | 받는 주소 |
| `AI_SHARED_SECRET` | (production 에서는 필수) | hamkke-api 와 같은 값. **문자열의 UTF-8 바이트**를 HS256 키로 쓴다. 32바이트 이상. `NODE_ENV` 가 production 이 아닐 때만 개발용 기본값을 쓰고, 시작할 때 경고를 남긴다 |
| `OLLAMA_URL` | `http://localhost:11434` | Ollama 주소. 바깥 주소면 https 로(2.1절) |
| `DAYCARE_API_ORIGIN` | 비어 있음 | 교사의 코칭 공유 권한과 이야기 작성 권한을 확인하는 API 출처. HTTPS 또는 로컬 루프백 HTTP를 사용한다. 어린이집 추천과 이야기 초안에 필요하다. |
| `VL_MODEL` | `qwen3.5:4b` | 모델 이름. 영수증의 `mv` 로 나간다 |
| `VL_MAX_CONCURRENCY` | `1` | 동시에 모델을 부르는 수 |
| `VL_MAX_WAITING` | `2` | 기다릴 수 있는 요청 수. 넘으면 429 `BUSY` |
| `VL_TIMEOUT_MS` | `180000` | 대기, 초안 작성, 시각 점검, 재시도를 합한 요청 제한 시간 |
| `VL_MAX_WAIT_MS` | `VL_TIMEOUT_MS` 의 절반 | 차례를 기다리는 시간의 상한. 넘으면 429 `BUSY`(토큰은 되돌린다). `VL_TIMEOUT_MS` 보다 클 수 없다 |
| `VL_KEEP_ALIVE` | `30m` | 모델을 메모리에 두는 시간. 예: `5m`(Ollama 기본값), `-1`(내리지 않음). 내려간 뒤 첫 요청은 모델을 다시 올리느라 6~9초 더 걸린다(내장 GPU 측정) |
| `VL_NUM_CTX` | `8192` | 문맥 길이. 사진 6장과 지시문이 들어가야 한다 |
| `VL_MAX_OUTPUT_TOKENS` | `480` | 한 번에 만드는 토큰 수 상한 |
| `VL_WARMUP` | `false` (compose 는 `true`) | `true` 면 서버가 뜬 뒤 모델을 미리 메모리에 올린다(2.2절). 기다리지 않는다 |
| `VL_FALLBACK_MODEL` | (없음) | 첫 모델을 쓸 수 없을 때 대신 쓰는 모델(2.3절). 영수증 `mv` 에는 실제로 쓴 모델이 들어간다 |
| `VL_FALLBACK_URL` | `OLLAMA_URL` | 대신 쓰는 모델의 Ollama 주소. `VL_FALLBACK_MODEL` 이 있어야 쓸 수 있다 |
| `OLLAMA_AUTH_TOKEN` | (없음) | Ollama 앞 TLS 프록시가 요구하는 토큰. 모든 모델 서버 요청에 붙는다. 로그에 남지 않는다 |
| `OLLAMA_AUTH_HEADER` | `Authorization` | 토큰을 담을 헤더 이름. `Authorization` 이면 `Bearer <토큰>`, 다른 이름(예: `X-Api-Key`)이면 토큰 그대로 |
| `OLLAMA_ALLOW_INSECURE` | `false` | production 에서 바깥 주소를 http 로 가리키는 설정을 허용한다(권하지 않음, 시작할 때 경고) |
| `METRICS_TOKEN` | (없음) | 정하면 `GET /ai/v1/metrics` 에 `Authorization: Bearer <값>` 이 있어야 한다. 16자 이상, `AI_SHARED_SECRET` 과 다른 값 |

값이 형식에 맞지 않으면 서버를 띄우지 않고 까닭을 알려 준다. 이 표와 `server/src/config.ts` 가 읽는 이름이 같은지, hamkke-api 의 `deploy/docker-compose.yml` 이 모두 넘기는지는 `server/test/config-env.test.ts` 가 확인한다.

### 2.1 모델 서버 연결: 인증과 전송 보안

장면 사진은 이 서버에서 Ollama 로 넘어간다. 그 구간도 지켜야 한다.

- `OLLAMA_URL`·`VL_FALLBACK_URL` 이 **바깥 주소를 http(평문)로** 가리키면 production 에서는 서버를 띄우지 않는다(개발에서는 경고). 안쪽 주소로 보는 것: `localhost`, 점이 없는 이름(compose 서비스 이름), `.internal`·`.local`·`.lan`·`.home.arpa`, 사설 IP(10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, 100.64/10), IPv6 `::1`·`fc00::/7`·`fe80::/10`. 꼭 평문으로 써야 하면 `OLLAMA_ALLOW_INSECURE=true`(시작할 때 경고).
- 주소에 사용자 이름·비밀번호를 넣지 않는다(`https://user:pw@…` 는 거절). 토큰은 `OLLAMA_AUTH_TOKEN` 으로 준다. 값은 로그·오류 코드에 들어가지 않는다. 모델 서버가 401·403 으로 거절하면 로그 `detail` 은 `auth_rejected` 다.
- GPU 기기의 Ollama 는 `127.0.0.1:11434` 에만 열고, 앞에 TLS 프록시를 둔다. Caddy 예(GPU 기기):

```
# /etc/caddy/Caddyfile — 토큰이 맞는 요청만 Ollama 로 넘긴다
vl.example.kr {
    @authed header Authorization "Bearer {env.OLLAMA_PROXY_TOKEN}"
    handle @authed {
        reverse_proxy 127.0.0.1:11434
    }
    respond 401
}
```

이때 AI 서버는 `OLLAMA_URL=https://vl.example.kr`, `OLLAMA_AUTH_TOKEN=<같은 토큰>`. 같은 사설망(VPC, Tailscale 등) 안이면 프록시 없이 사설 주소를 써도 된다.

### 2.2 모델 미리 올리기 (`VL_WARMUP`)

Ollama 는 쓰지 않는 모델을 `keep_alive`(기본 5분)가 지나면 내린다. 내려간 모델을 다시 올리는 데 걸리는 시간은 첫 요청의 제한 시간에서 빠진다.

- `VL_WARMUP=true` 면 서버가 요청을 받기 시작한 **뒤에** `POST /api/generate {model, keep_alive}`(프롬프트·사진 없음)를 한 번 보내 모델을 올린다. 기다리지 않으므로 그동안 들어온 요청도 그대로 처리된다.
- 결과는 로그 한 줄: `warmup_done`(걸린 시간) 또는 `warmup_failed`(짧은 코드). 실패해도 서버는 그대로 동작하고, 첫 요청이 모델을 올린다.
- `VL_KEEP_ALIVE=30m` 과 함께 쓴다(compose 기본값). 대신 쓰는 모델은 미리 올리지 않는다(같은 GPU 에서 서로 밀어낼 수 있다).

### 2.3 대신 쓰는 모델 (`VL_FALLBACK_MODEL`)

- 첫 모델(`VL_MODEL`)에 닿지 못하거나 쓸 수 없을 때(`ProviderUnavailableError`: 연결 실패, 모델 없음, 사진을 못 보는 모델, HTTP 오류, 인증 거절)만 대신 쓰는 모델로 넘어간다. 제한 시간이 지났거나 요청한 쪽이 끊은 호출은 넘기지 않는다.
- 첫 모델이 실패하면 30초 동안은 첫 모델을 건너뛰고 바로 대신 쓰는 모델을 부른다. 건강 확인에서 첫 모델이 다시 준비되면 바로 첫 모델로 돌아간다.
- **영수증 `mv`와 응답 `modelVersion`에는 초안을 실제로 작성한 모델 이름**이 들어간다. 대신 쓰는 모델이 초안을 작성하면 요청 로그에 `"fallback":true`가 붙는다. 초안 작성과 시각 점검 중 대신 쓰는 모델로 넘어갈 때마다 `fallback_model_used` 로그가 남는다.
- 건강 확인의 `modelReady` 는 둘 가운데 하나라도 쓸 수 있으면 `true` 이고, 응답에 `fallbackModel` 이 붙는다.
- 대신 쓰는 모델에도 해당 단계의 지시문을 그대로 보낸다. 초안 작성에는 `obs-v2` 지시문을, 시각 점검에는 같은 사진과 독립적인 확인 항목을 보낸다. 사진이 다른 회사의 서버로 나가는 제공자는 붙이지 않는다(10장).

## 3. API

### `POST /ai/v1/analyze`

`Authorization: Bearer <분석 토큰>`, `Content-Type: application/json`

```json
{ "frames": [ { "t": 12.5, "jpeg": "<base64>" } ], "durationSec": 95 }
```

| 항목 | 제한 |
|---|---|
| 본문 전체 | 2MB(2,097,152바이트) 이하. `Content-Length` 로 먼저 보고, 읽으면서도 센다 |
| 사진 장수 | 서명된 `mf` 장수 안에서 1~24장. `mf`가 없는 토큰과 기관 토큰은 최대 6장 |
| 사진 한 장 | 디코딩 크기 300KB(307,200바이트) 이하, 표준 base64(`data:` 머리말 없이) |
| 형식 | JPEG 만. 시작 바이트 `FF D8 FF` 와 머리 부분의 크기 정보를 확인한다 |
| 그림 크기 | 한 변 16~2048px (웹은 긴 변 512px 로 보낸다) |
| `t`, `durationSec` | 0 이상의 수(초). `durationSec` 은 없어도 된다 |
| JSON | 중첩 6단계까지 |

사진은 `t` 순서로 정렬해서 모델에 보낸다. 응답의 `moments[].t` 는 **보낸 `t` 값 가운데 하나**다.

응답 200

```json
{
  "observation": { "summary": "…", "childStates": [], "adultResponses": [], "moments": [], "peopleCount": 2 },
  "receipt": "<JWS>",
  "modelVersion": "qwen3.5:4b",
  "promptVersion": "obs-v6.9-ear-timing",
  "analyzedFrames": 4
}
```

오류는 모두 `{ "code": "...", "message": "한국어 문장" }` 이다.

| 상태 | code | 언제 |
|---|---|---|
| 400 | `INVALID_FRAMES` | 본문이 JSON 이 아님, 사진 장수·크기·형식이 맞지 않음 |
| 401 | `INVALID_TOKEN` | 토큰 없음, 서명·`iss`·`aud`·만료·필수 클레임이 맞지 않음, HS256 이 아닌 알고리즘 |
| 409 | `SESSION_ALREADY_USED` | 같은 `jti` 로 이미 처리를 시작함 |
| 413 | `PAYLOAD_TOO_LARGE` | 본문이 2MB 를 넘음 |
| 429 | `BUSY` | 대기열이 가득 참(`Retry-After: 10`). 이 경우 토큰은 쓴 것으로 치지 않는다 |
| 502 | `MODEL_UNAVAILABLE` | 허용된 시도 안에 초안을 받지 못하거나 검사·점검 후 남은 관찰이 없음 |
| 504 | `MODEL_TIMEOUT` | 제한 시간을 넘김 |
| 404 | `NOT_FOUND` | 모르는 주소 |
| 405 | `METHOD_NOT_ALLOWED` | 주소는 맞지만 방식이 다름(`Allow` 헤더) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `Content-Type` 이 `application/json` 이 아님 |
| 500 | `INTERNAL_ERROR` | 그 밖의 오류 |
| 401 | `UNAUTHORIZED` | `GET /ai/v1/metrics` 에 `METRICS_TOKEN` 과 맞는 Bearer 토큰이 없음(`WWW-Authenticate: Bearer`) |

아래 다섯 줄(404·405·415·500, 지표의 401)은 공통 명세에 없는 상황에 쓰는 코드다.

토큰이 쓰인 것으로 기억되는 때는 **검사를 모두 지나 대기열에 들어간 순간**이다. 400·413·415·429 로 거절된 요청의 토큰은 다시 쓸 수 있고, 모델을 부른 뒤 502·504 로 끝난 요청의 토큰은 다시 쓸 수 없다(새 토큰을 받는다).

### `POST /ai/v1/observation-guidance`

연결된 교사가 보호자의 관찰 기록을 검토할 때 사용한다. 교사 로그인 토큰과 `{childId, observationId, summary?}`를 받는다. 교사가 관찰 내용을 수정하면 `summary`에 수정본을 넣는다. 이때 검색 대상은 수정한 문장뿐이다. 원래 내용으로 요청하면 요약과 시각별 관찰 메모에서 행동 단서를 찾는다.

PC는 `DAYCARE_API_ORIGIN`의 검토 API에서 교사 연결, 공유, 동의와 대기 상태를 확인한다. 로컬 SQLite의 FTS5 검색 색인에서 해당 행동과 기록 당시 나이에 맞는 단락을 찾고, 로컬 모델이 관찰과 단락을 대조해 최대 두 건을 선택한다. 응답에는 관찰 문장, 행동 제안, 이유, 발행기관, 문서명, 세부 절과 원문 주소를 담는다. 대응 문구와 인용 정보는 선택한 근거 단락에 미리 연결한 한국어 문안이다. 모델이 맞는 근거를 찾지 못하면 추천 배열이 빈 상태로 돌아온다.

울음 검색은 아이가 직접 하는 행동을 기술한 문장만 사용한다. `울며`, `울면서`와 같은 활용형은 색인에 있는 `울고`와 함께 검색한다. 어른이나 인형을 수식하는 울음, 들려오는 울음, 자막이나 흉내, 끝난 울음 표현은 울음 자료 검색에 넣지 않는다. 근거의 대상 월령은 그대로 적용한다.

귀 가림은 아이의 손이 자기 귀를 가리거나 귀에 닿는 모습이 문장에 있을 때만 환경 조정 자료와 연결한다. 귀를 가린 이유와 영상 속 소리는 사진으로 판단하지 않는다. 조용한 곳에서 잠시 쉬는 선택은 아이의 반응에 따라 교사가 검토한다.

교사에게 돌려주기 직전에 권한과 기록 상태를 다시 확인한다. 응답의 `receipt`는 교사·아이·기록·검토 문장·추천·자료판을 묶은 15분 유효 서명이다. 교사가 API에 발행을 요청할 때 이 서명과 선택한 출처 ID를 보내면 보호자가 결과를 읽을 수 있다.

공개 문헌의 한국어 요지, 적용 범위, 출처 표기는 `server/evidence/passages.sql`에서 관리한다. 검색 DB에는 공개 문헌만 넣으며, 아이의 관찰과 교사 세션은 넣지 않는다. Node 24에서 `node server/evidence/build.mjs`로 DB를 재생성한다. 자료를 갱신할 때는 자료판과 SQLite 파일 이름도 함께 바꾸면 현재 서비스가 읽고 있는 파일과 새 자료를 동시에 검증할 수 있다. 자동 검사에서는 배포할 DB의 모든 단락과 검색 색인을 원본 SQL에서 재구성한 결과와 비교한다.

### `GET /ai/v1/health`

```json
{ "status": "ok", "model": "qwen3.5:4b", "modelReady": true }
```

인증 없음. `modelReady` 는 Ollama 에 닿고, 모델이 설치되어 있고, 그 모델이 사진을 볼 수 있을 때 `true`(대신 쓰는 모델이 있으면 둘 가운데 하나라도). 확인 결과를 5초 동안 기억한다. 대신 쓰는 모델을 정했으면 `"fallbackModel": "…"` 이 붙는다.

- 기본(쿼리 없음): **언제나 200**. 서버가 살아 있는지 보는 용도(컨테이너 `HEALTHCHECK`).
- `?strict=1`(또는 `?strict=true`): 모델을 쓸 수 없으면 **503** `{ "status": "unavailable", "model": "…", "modelReady": false }` 와 `Retry-After: 10`. 바깥 가동 감시와, 웹이 촬영을 시작하기 전에 확인하는 용도. 503 응답은 로그에 `code` `MODEL_NOT_READY` 로 남는다(200 건강 확인은 남지 않는다).

### `GET /ai/v1/metrics`

Prometheus 글 형식(`text/plain; version=0.0.4`). `METRICS_TOKEN` 을 정했으면 `Authorization: Bearer <값>` 이 있어야 하고, 없거나 다르면 401 `UNAUTHORIZED`. **nginx 는 이 경로를 밖에서 막는다**(hamkke-web `nginx.conf`, 404). 같은 docker 망의 수집기가 `http://ai:8090/ai/v1/metrics` 로 읽는다.

| 지표 | 종류 | 뜻 |
|---|---|---|
| `hamkke_ai_requests_total{route,status,code}` | counter | 경로(`analyze`·`health`·`metrics`·`other`)·HTTP 상태·결과 코드별 요청 수 |
| `hamkke_ai_request_duration_seconds{route}` | histogram | 처리 시간(구간 0.05~300초) |
| `hamkke_ai_model_calls_total{result}` | counter | 초안과 점검을 묶은 시도별 결과. 요청당 최대 두 건의 `ok`, `bad_output`, `unavailable`, `timeout`, `aborted`를 기록한다 |
| `hamkke_ai_observations_total{model,fallback}` | counter | 돌려준 관찰 기록 수(쓴 모델, 대신 쓰는 모델이었는지) |
| `hamkke_ai_queue_active`, `hamkke_ai_queue_waiting` | gauge | 지금 모델을 부르는 수, 차례를 기다리는 수 |
| `hamkke_ai_queue_max_concurrency`, `hamkke_ai_queue_max_waiting` | gauge | 설정값 |
| `hamkke_ai_model_ready` | gauge | 모델을 쓸 수 있으면 1(건강 확인과 같은 5초 기억) |
| `hamkke_ai_used_sessions` | gauge | 만료 전까지 기억하는 분석 토큰 수(값이 아니라 개수만) |
| `hamkke_ai_info{model,fallback_model,prompt_version}` | gauge | 늘 1. 모델·프롬프트 버전 |
| `hamkke_ai_start_time_seconds` | gauge | 서버가 뜬 시각 |

지표에는 사진, 관찰 문장, 토큰, `jti`, 요청 id, 아이·사용자를 가리키는 값이 없다. 라벨 값은 정해 둔 목록(경로·결과 코드)과 모델 이름뿐이다. 성공한 수집은 로그에 남지 않는다.

## 4. 토큰과 영수증

둘 다 HS256 JWT, 키는 `AI_SHARED_SECRET`. 구현은 `server/src/jwt.ts`(node:crypto 만 사용, 서명 비교는 `timingSafeEqual`).

- **분석 토큰**(api 발급 → 여기서 검증): `iss=hamkke-api`, `aud=hamkke-ai`(문자열, 또는 그 값을 담은 배열), `sub`(문자열), `cid`(양의 정수), `src`(`HOME`|`INSTITUTION`), `jti`, `iat`, `exp`.
- **영수증**(여기서 발급 → api 검증, 15분): `iss=hamkke-ai`, `aud=hamkke-api`, `sub`·`cid`·`src`·`jti` 는 분석 토큰 그대로, `obs`(검사를 마친 관찰 기록), `mv`(모델), `pv`(프롬프트 버전), `fc`(사진 장수), `iat`, `exp`.

`jti` 는 메모리에 만료 시각까지 기억한다. 서버를 다시 켜면 비워지지만, hamkke-api 가 영수증의 `jti` 를 DB unique 로 한 번 더 막는다.

## 5. 관찰 기록 객체와 태그

| 필드 | 규칙 |
|---|---|
| `summary` | 한국어 해요체, 1~3문장, 300자 이하. 쓸 수 있는 문장이 없으면 `null` |
| `childStates` | 아래 목록에서 0~3개 |
| `adultResponses` | 아래 목록에서 0~3개 |
| `moments` | 0~4개. `t` 는 보낸 사진의 시각, `note` 는 120자 이하 |
| `peopleCount` | 0~3 (3은 '3명 이상') |

아이 모습 `childStates`: `PLAYING_TOGETHER`(어른과 함께 놀아요) · `PLAYING_ALONE`(혼자 놀아요) · `FOCUSED`(한 가지에 푹 빠져 있어요) · `MOVING_AROUND`(자리를 자주 옮겨요) · `SEEKING_ADULT`(어른에게 다가가요) · `UPSET_CRYING`(울거나 속상해해요) · `REFUSING`(싫다고 표현해요) · `THROWING_OR_HITTING`(물건을 던지거나 쳐요) · `CALM`(차분해요)

어른 반응 `adultResponses`: `JOINING_PLAY`(놀이에 함께해요) · `TALKING`(말을 걸어 줘요) · `WAITING`(기다려 줘요) · `COMFORTING`(안아 주거나 달래 줘요) · `REDIRECTING`(다른 놀이로 이끌어요) · `SETTING_LIMIT`(안 되는 것을 알려 줘요)

목록은 `server/src/observation.ts` 에 있고, 프롬프트와 JSON 스키마가 그 값을 가져다 쓴다. 태그를 바꾸려면 공통 명세를 먼저 고치고 세 저장소를 함께 바꾼다.

## 6. 모델 출력 검사

모델이 쓴 글은 그대로 믿지 않는다(`server/src/observation.ts`).

1. JSON 객체가 아니거나 `peopleCount` 가 수가 아니면 쓸 수 없는 출력이다.
2. 태그: 목록에 없는 값과 겹친 값을 빼고 3개까지만 남긴다.
3. 문장(`summary`, `note`):
   - 글자를 고르게 맞춘다: NFKC(전각 숫자·영문 → 반각, 풀어 쓴 한글 자모 → 완성형) → 보이지 않는 글자(폭 없는 공백·이음표, BOM, 한글 채움 문자 등)를 **지운다** → 줄바꿈·제어 문자는 공백으로 → 공백을 하나로 줄인다. 보이지 않는 글자를 공백으로 바꾸면 낱말 사이에 끼워 넣어 검사를 비켜 갈 수 있어서 지운다. 저장되는 글도 이렇게 맞춘 글이다.
   - **문장 검사에 걸리면 그 글 전체를 버린다**(`summary` 는 `null`, 그 `moment` 는 제거). 목록은 `server/src/wording.ts` 한 곳에 있다: 표현 규칙 검수 스크립트와 같은 금지 표현, 그리고 평가·분류·원인 추정·조언처럼 읽히는 말(`문제`, `장애`, `이상`, `정상`, `비정상`, `지연`, `부족`, `산만`, `공격`, `과잉`, `결핍`, `의심`, `해야`, `하세요`, `바랍니다`, `권장`), 그리고 아래 6.1절의 갈래.
   - 한글이 없거나 한자·가나가 섞인 글은 버린다.
   - 길이: `summary` 는 3문장·300자, `note` 는 120자. 되도록 문장 단위로 줄인다.
4. `moments`: `t` 를 보낸 사진 시각 가운데 가장 가까운 값으로 맞추고, 시각 순서로 4개까지.
5. 남은 것이 하나도 없으면(문장도 태그도 순간도 없음) 쓸 수 없는 출력이다.

초안 작성에 실패하거나 최종 점검 뒤 남는 기록이 없으면 초안부터 최대 한 번 다시 시도한다. 남은 시간이 첫 시도에 걸린 시간보다 짧거나 재시도도 실패하면 502 `MODEL_UNAVAILABLE`로 끝난다. 점검만 실패한 경우는 7장의 처리 규칙을 따른다.

공통 명세보다 조금 더 엄격하게 본 것(모두 '버리는' 쪽이라 hamkke-api 의 두 번째 검사와 어긋나지 않는다):

- 해요체가 아닌 문장('~습니다', '~한다'로 끝나는 문장)은 그 문장만 뺀다.
- 나이 표기(예: '5살', '세 살')나 생김새를 평가하는 말이 들어간 글은 버린다. 명세는 프롬프트에서 막으라고만 했다.
- `peopleCount` 가 0 이면 태그와 `moments` 를 비운다(사람이 없는 장면). 이때 모델 요약이 검사에 걸리거나 없으면 프롬프트 규칙 8 의 문장 "화면에 아이가 보이지 않아요."를 요약으로 쓴다(사진 속 글자를 옮겨 적은 요약 때문에 기록 전체가 502 가 되던 경우. 사람이 있는 장면에는 지어낸 요약을 넣지 않는다).
- 서로 다른 실제 입력 시각이 하나뿐이면 반복 이동(MOVING_AROUND), 기다림(WAITING), 말을 걸었는지(TALKING)는 정지 장면만으로 확인할 수 없어 해당 태그를 제외한다. 요약·순간 메모와 다른 태그는 이전 규칙으로 검사한다. 여러 시점이 주어져도 소리가 없는 입력에서는 최종 기록의 TALKING 태그를 비운다.
- 시각이 달라도 같은 말을 되풀이한 `moment` 는 처음 것만 남긴다.

### 6.1 문장 검사가 거르는 갈래 (2026-11 에 넓힘)

사진 몇 장으로 알 수 없는 것을 말하거나 아이를 가려내는 말로 읽히는 글을 버린다. **버리는 쪽으로만** 넓혔고, 맞는 관찰 문장이 일부 버려지는 것을 받아들였다. 식은 `server/src/wording.ts` 에 있고 hamkke-api 의 `ObservationSentenceFilter` 가 같은 식을 갖는다.

| 갈래 | 코드 | 걸리는 예 |
|---|---|---|
| 조언·부탁 | `ADVICE_PATTERNS` | '안아 주세요', '달래 주면 좋겠어요', 어른 높임말('앉아 계세요') |
| 속마음·까닭 짐작 | `GUESS_PATTERNS`, `INNER_STATE_PATTERNS`, '-ㄴ가 봐요', '-ㄴ/ㄹ 듯' | '졸려 보여요', '불안해 보여요', '화가 난 듯', '심심해서 돌아다녀요', '피곤한지 눈을 비벼요', '나가고 싶어 해요' |
| 발달·또래 견주기, 아이에게 이름 붙이기 | `LABELING_PATTERNS` | '발달이 느려 보여요', '또래보다 말이 늦어요', '자폐 성향이 보여요', 'ADHD처럼 보여요', '눈을 맞추지 않아요', '조용한 편이에요', '고집이 세요' |
| 평가하는 말 | `JUDGING_PATTERNS` | '버릇없이', '집중을 못 해요', '떼를 쓰며', '말을 안 듣고', '휴대폰만 보고', '잘 쌓아요', '혼내요' |
| 사람을 가리키는 말 | `PERSONAL_PATTERNS`, `PERSON_PATTERNS` | '엄마가', '선생님이', '친구와', '남자아이', '두세 살쯤', '돌쯤', '초등학생으로 보이는', '5살', 생김새를 평가하는 말 |
| 사진 속 글자 읽기 | `READING_PATTERNS` | '민준이라고 적혀 있어요', '이름표', 따옴표로 옮긴 말 |

- 다른 낱말 속에 든 글자는 되도록 건드리지 않게 좁혔다: '인형'·'딸기'·'양말'·'통과해요'·'조심스럽게'·'평균대'·'아기 인형'·'돌을 쌓아요'·'보여 줘요'는 지나간다.
- 그래도 버려지는 맞는 문장이 있다. 예: '반듯하게 앉아 있어요', '손이 닿지 못해', '장난감 말을 들어 올려요', '상자보다 큰 인형', '꼬마 자동차', '블록을 높게 쌓아 보여요'. 이런 글은 `summary` 가 `null` 이 되거나 그 `moment` 가 빠진다(태그는 남는다).
- **예문 파일** `server/test/wording-cases.json`: 걸려야 하는 문장과 지나가야 하는 문장을 모아 둔 파일이다. `server/test/wording.test.ts` 가 그대로 돌리고, hamkke-api 가 바이트 단위로 같은 사본을 돌린다. 식을 고치면 이 파일과 두 저장소의 식을 함께 고친다. 줄바꿈은 LF, 보이지 않는 글자는 `\u` 로 적는다.

## 7. 관찰 프롬프트와 영수증 버전

`obs-v6.4-release`는 던지기 후보를 같은 장면 사진으로 다시 점검한다. 먼저 손에 물체가 있고 이어지는 사진에서 손을 떠난 같은 물체가 공중에 보인다는 응답을 요구한다. 서로 다른 두 사진과 순서가 맞고 간격이 2초 이내일 때만 던졌다고 적는다. 성긴 표본은 짧은 동작을 놓칠 수 있다. 시각과 움직임이 불확실할 때는 남아 있는 다른 관찰을 기록한다. 사진에서 소리의 크기, 비명, 화자를 추론하지 않는다.

`obs-v6.5-windowed`는 시각순 사진을 최대 6장씩 나눠 각 구간에서 같은 관찰과 검토를 실행한다. 검토를 마친 메모 중 뚜렷한 아이 행동과 다른 구간의 장면을 골라 시간순으로 함께 담는다. 요약에는 이미 확인한 문장을 사용한다. 사람 수는 구간별 최댓값을 사용하며 사진에서 보지 못한 시간의 행동은 기록하지 않는다. 영수증 `fc`는 분석에 사용한 사진 수이며 본문 상한은 기존 2 MiB다.

`obs-v6.6-contact`와 `obs-v6.6-windowed`는 머리카락을 잡거나 머리에 손을 대는 메모가 있을 때, 메모와 같은 시각의 사진에서 손의 주인과 머리의 주인을 확인한다. 두 역할이 초안과 확인에서 일치할 때만 역할을 함께 표시한다. 접촉만 보일 때는 머리 쪽에 손이 닿은 모습만 적는다. 접촉을 볼 수 없거나 장면 시각이 없으면 해당 문장을 뺀다. 같이 확인한 걷기, 안기, 울음처럼 독립적인 메모는 보존한다.

`obs-v6.8-expression`은 미소 표현이 있는 장면의 사진에서 아이와 어른의 입 모양을 따로 확인한다. 입꼬리가 올라간 모습이 분명하면 미소를, 입이 벌어진 모습만 분명하면 입 모양을 기록한다. 표정을 확인하기 어려운 경우에는 표정 표현을 빼고 같은 문장의 손동작 같은 관찰을 보존한다.

`obs-v6.9-ear-timing`은 귀 가림으로 기록된 시각부터 인접 사진을 각각 확인한다. 가림으로 분류된 사진에서는 손이 귀에 닿아 귀 위를 덮고 있는지 다시 확인한다. 첫 확인 사진의 시각을 쓰고, 들거나 닿기만 한 손은 그 사진에 따로 기록한다. 같은 문장의 독립적인 행동은 원래 시각에 둔다. 사진 사이에서 동작을 시작한 시각은 추정하지 않는다.

`server/src/prompt.ts`. 한국어 지시문 + 요청문 + JSON 스키마(Ollama `format`)로 이루어진다.

- 보이는 것만 시간 순서대로, 해요체로 짧게. 어른에게도 높임말을 쓰지 않는다('앉아 계세요'가 아니라 '앉아 있어요').
- 사람은 '아이', '어른'이라고만 부른다. 식구·기관 사람을 가리키는 말, 성별, 이름, 나이(어림한 나이도), 생김새·옷차림에 대한 느낌을 쓰지 않는다. 아이가 여럿이면 '다른 아이'.
- 기분이나 까닭을 짐작하지 않고 표정과 몸짓만 적는다. 조언하지 않는다.
- 아이나 어른을 평가하거나 이름 붙이지 않는다. 다른 아이와 견주지 않고, 자라는 속도·성격·평소 모습처럼 사진만으로 알 수 없는 것을 쓰지 않는다.
- 태그는 목록의 값만, 분명히 보일 때만.
- 아이가 보이지 않으면 그렇다고만 적고 태그와 `moments` 는 비운다.
- 사진 속 글자를 읽어서 옮기지 않고, 따옴표를 쓰지 않는다.
- 요청문에 사진마다 시각을 적어 준다(`- 사진 2: t=12.5`). 스키마의 `moments[].t` 는 그 시각들만 허용한다.

`obs-v1` → `obs-v2`(2026-11): 문장 검사가 버리는 글이 처음부터 덜 나오게 규칙을 보강했다(높임말, 사람을 부르는 말, 기분·까닭 짐작, 견주는 말, 사진 속 글자). 태그 목록과 스키마는 그대로다. 실제 모델에서 버려지는 글이 얼마나 줄었는지는 `npm run eval:vl` 로 아직 재지 않았다.

`obs-v6.3.2-actions`는 앞의 지시문과 스키마로 초안을 작성한다. 이어 같은 사진을 한 번 더 보고, 보이는 신체 범위·사람 수·놀이 근거를 독립적으로 확인한다. 점검 모델은 초안이나 평가 자료의 인물 정보를 받지 않는다.

- 초안과 점검이 모두 한 사람의 손이나 팔만 잡힌 화면을 가리키면 "어른의 손"을 "손"으로 바꾸고 연령을 전제하는 태그를 뺀다. 서기·걷기 등 전신 동작이 있는 초안에서 점검 모델의 단독 판단만으로 호칭을 고치지 않는다.
- 입력에는 소리가 없다. `TALKING` 태그와 대화로 단정하는 표현을 거른다. 한 문장에 여러 동작이 있으면 대화 앞에서 복원 가능한 가장 긴 행동 절과 뒤에 이어지는 독립된 행동 절을 남긴다. 예를 들어 “아이가 물건을 들고 창문을 바라보며 질문해요”는 “아이가 물건을 들고 창문을 바라봐요”로 정리한다.
- 초안에 공동놀이 태그·문장이나 여러 행위자가 등장하면 첫 사진, 가운데 사진, 마지막 사진을 각각 따로 확인한다. 겹치는 사진은 한 번만 확인한다. 각 사진에서 사람의 위치와 동작을 먼저 기술하고, 두 사람이 같이 하는 놀이인지, 일상 작업인지, 한 사람이 구경하는지만 확인되는지를 분류한다. 서로 다른 시점에 같은 사람이 반복해서 보일 수 있다.
- 검출된 사람이 둘이거나 여러 사진에서 한 사람이 다른 사람의 몸을 받쳐 주는 장면이 확인되면, 장면에 손만 보인다는 분류로 실제 두 사람의 지지 동작까지 지우지 않는다. 여러 사진에 한 사람의 손만 기술되고 둘째 사람의 동작과 놀이 근거가 없으면, 인원수를 확정하기 어려운 장면에서도 공동놀이 태그를 보류한다.
- 한 문장에서 확인하기 어려운 상대·교환 표현을 걷어낼 때 단일 행위자의 걷기·몸 숙이기·물체 다루기는 남긴다. 연령이 불분명한 신체 일부는 “손” 또는 “사람”으로 쓴다. 웃음·고개 돌림·손 들기는 초안과 독립 사진의 행위 묘사가 일치하면 원문의 주체와 함께 복원할 수 있다.
- 단독 행위가 확인됐고 둘째 사람 관련 표현을 걷어낸 뒤 요약에 자세만 남거나 요약이 비어 있으면, 초안에서 물체를 움직인 서술을 확인한다. 한 사진에서 물건을 다른 물건 위에 올리는 동작을 직접 묘사하고 다른 사진에서도 물건을 들거나 올리는 동작이 확인될 때 그 행동을 요약에 담는다. 이 복원은 요약에만 적용한다. 일반적인 빈 요약을 채울 때도 초안에 물체를 올려놓는 동작이 명시돼야 한다.
- 인원수가 양수인 기록에서 연령 단정을 고치다가 “어른은 없어요”가 “사람은 없어요”로 넓어질 수 있다. 마지막 단계에서 요약은 원래 요약과, 시점 메모는 정확히 같은 시각의 원래 메모와 대조한다. 호칭과 조사만 바뀌면서 부정 대상이 모든 사람으로 넓어진 명백한 구절은 걷어낸다. 원래부터 빈 화면을 설명한 메모나 “다른 사람”, “잠시”, “손이 안 보인다”처럼 대상·시점이 다른 표현은 유지한다. 해당 메모에 다른 사실이 없으면 같은 시각에 동작이 분명하지 않다고 기록한다.
- 선택한 사진을 PC의 CPU 인물 검출기에도 한 번 전달한다. 어느 사진에서든 서로 다른 사람 박스가 둘 이상이면 여러 사람을 한 사람으로 합치지 않는다. 검출값 0은 그 사진에서 사람 박스를 찾지 못했다는 뜻이다. 영상 모델이 한 행위자를 반복해 기술하고 다른 행위자의 근거가 없으며 CPU 근거도 모순되지 않을 때 단독 행동과 확인 가능한 물체 동작을 남긴다. 근거가 모자라면 공동놀이를 보류하고 인원수는 유지한다. 기록에 얼굴 신원이나 인물 위치 기술을 저장하지 않는다. 검출기가 작동하지 않으면 독립 사진 판독만 사용한다. [검출기 모델과 설치](../server/vision/README.md)
- 초안이 한 사람을 기록하고 시각 점검도 단독 행동을 뒷받침하면 공동놀이 표현과 태그를 뺀다. 손 클로즈업 예외가 아닌 장면에서 초안이 명시한 단독놀이는 유지한다. 부재가 확인된 빈 장면은 기존 정규화 규칙을 따른다.
- 요청 한 번에서 초안 작성 한 번, 전체 장면 확인 한 번, 선택한 개별 사진 확인 최대 세 번을 수행한다. 빈 화면이나 한 사람의 관찰에는 일부 호출을 생략한다. 모든 호출이 한 대기열 자리와 같은 요청 제한시간을 쓴다. 처리 중 제한시간이 지나면 HTTP 504로 끝난다.

지시문·태그·스키마를 바꾸면 `PROMPT_VERSION` 을 올린다(`obs-v3` …). 영수증의 `pv` 로 저장되므로 어떤 지시문으로 쓴 기록인지 나중에 가릴 수 있다. hamkke-api 는 `pv` 를 40자 이하 글자로만 받고 값의 목록은 두지 않는다.

## 8. 대기열과 제한 시간

- 동시에 `VL_MAX_CONCURRENCY` 건만 모델을 부르고, `VL_MAX_WAITING` 건까지 차례를 기다린다. 넘으면 바로 429.
- 제한 시간은 대기열에 들어간 때부터 잰다. 모델 호출 중에 넘기면 호출을 끊고 504, 차례를 기다리다 넘기면 429(토큰은 되돌린다).
- 요청한 쪽이 연결을 끊으면 모델 호출도 끊고 자리를 내놓는다.
- nginx 의 `/ai/` 읽기 제한 시간(200초)은 `VL_TIMEOUT_MS`(180초)보다 길어야 한다.

## 9. 로그

요청 하나에 JSON 한 줄. 사진, base64, 토큰, `summary`·`note` 문장은 남기지 않는다.

```json
{"ts":"…","rid":"<요청 id>","route":"analyze","jti":"<jti 의 SHA-256 앞 12자>","frames":4,"bytes":88984,"ms":25470,"status":200,"code":"OK","attempts":1}
```

실패하면 `detail` 에 짧은 코드가 붙는다(예: `not_jpeg`, `frame_count`, `queue_full`, `connect`, `auth_rejected`, `chat_http_500`, `bad_output`). 대신 쓰는 모델이 기록을 썼으면 `"fallback":true` 가 붙는다. 요청한 쪽이 먼저 끊은 요청은 `status` 499, `code` `CLIENT_CLOSED` 로 적는다(응답은 나가지 않는다). 문제없이 끝난 건강 확인과 지표 수집은 적지 않는다. 응답의 `X-Request-Id` 헤더가 `rid` 와 같다.

요청 로그 말고 서버가 남기는 줄: `listening`(설정 요약, 비밀 값 없이 인증을 쓰는지만), 설정 경고, `warmup_done`·`warmup_failed`, `fallback_model_used`, `stopping`. 컨테이너 로그는 compose 가 10MB × 5개로 돌려 쓴다(hamkke-api `docs/deploy.md` 8장).

## 10. 다른 모델 제공자 붙이기

제공자는 `server/src/provider.ts` 의 인터페이스 하나다.

```ts
export interface VisionProvider {
  readonly modelVersion: string;                                   // 기본 모델 이름(영수증 mv)
  generate(request: VisionRequest): Promise<string | VisionOutput>; // 모델이 쓴 JSON 글 그대로
  isReady(signal: AbortSignal): Promise<boolean>;                   // 건강 확인용
  warmUp?(signal: AbortSignal): Promise<void>;                      // (선택) VL_WARMUP
  readonly fallbackModelVersion?: string;                           // (선택) 대신 쓰는 모델 이름
}
// VisionOutput = { text, modelVersion }: 다른 모델이 대신 썼을 때 그 이름을 함께 돌려준다(영수증 mv).
```

1. `server/src/<이름>.ts` 에 `create…Provider()` 를 만든다. `request.system`·`request.user`·`request.images`(JPEG base64, 시각 순서)·`request.schema` 를 그 서비스의 형식으로 옮겨 보내고, 글을 그대로 돌려준다. 해석·검사·다시 시도·영수증은 서버가 한다.
2. `request.signal` 을 호출에 넘긴다(제한 시간·연결 끊김). 닿지 못하면 `ProviderUnavailableError('짧은 코드')` 를 던진다. 사진이나 응답 글을 저장하거나 로그에 남기지 않는다.
3. `server/src/providers.ts` 의 `createProviderFromConfig` 에서 `createOllamaProvider` 대신 끼운다(환경 변수로 고르게 해도 된다). 대신 쓰는 모델로 감싸려면 `createFallbackProvider(primary, fallback)`(`server/src/fallback.ts`).
4. `server/test/ollama.test.ts` 처럼 가짜 fetch 로 테스트를 붙인다.

사진이 다른 회사의 서버로 나가는 제공자를 쓰려면 동의 화면의 '어디로' 문구와 처리 위탁 고지를 먼저 고쳐야 한다.

## 11. 시각 점검을 추가하기 전 걸린 시간 (2026-11-13, 개발 기기 CPU 측정)

| 입력 | 걸린 시간 |
|---|---|
| 512×384 합성 무늬 4장 | 25.5초 |
| 512×384 합성 무늬 6장 | 57.6초 |
| 그림으로 그린 어른·아이 장면 4장 | 54.8초 |

모두 제한 시간(180초) 안이다. GPU 가 있으면 훨씬 빨라진다. 이 숫자는 속도만 본 것이고, 실제 영상에서 기록이 본 것과 맞는지는 연출 영상으로 사람이 따로 확인해야 한다. 그 비교 도구가 `server/eval/`(`npm run eval:vl`)다: 사람이 붙인 태그와 모델이 붙인 태그의 일치·놓침·더함 수, 문장 검사에 걸린 글 수를 센다. 사용법은 [server/eval/README.md](../server/eval/README.md).

## 12. 테스트

```bash
npm test             # server/test/*.test.ts 포함 (가짜 제공자, 네트워크·모델 없음)
npm run typecheck    # 분석 패키지 + server/ (server/eval 포함)
node scripts/check-expressions.mjs
npm run eval:vl -- --labels server/eval/vl-labels.json   # 실제 모델로 품질 비교(사진·라벨 필요, 커밋하지 않음)
```

CI(`.github/workflows/ci.yml`)는 위 세 가지에 더해 서버를 모델 없이 띄워 `/ai/v1/health`(200)·`?strict=1`(503)·`/ai/v1/metrics` 를 확인하고, Docker 이미지를 compose 와 같은 조건(읽기 전용, 권한 없음)으로 띄워 건강 확인을 보며, 비밀 없이 production 으로 띄우면 기동하지 않는지 본다.

`server/src/wording.ts` 는 문장 검사에 쓰려고 금지 표현 목록을 담고 있어서 표현 규칙 검수에서 이 파일 하나만 뺀다. 두 목록이 같은지는 `server/test/wording.test.ts` 가 확인한다. 예문 파일 `server/test/wording-cases.json` 에는 금지 표현을 그대로 적지 않으므로(보이지 않는 글자를 끼운 예만 `\u` 로 적는다) 검수 대상에 그대로 둔다.
