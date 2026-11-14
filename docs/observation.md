# AI 관찰 기록 서버 (hamkke-ai `server/`)

세 저장소가 함께 지키는 약속은 hamkke-api 의 `docs/ai-observation.md` 다. 이 문서는 그 가운데 **AI 서버 쪽**을 적는다:
무엇을 받고 무엇을 돌려주는지, 어떻게 띄우는지, 모델을 어떻게 바꾸는지.

- 프롬프트 버전: `obs-v1` (`server/src/prompt.ts`)
- v1 모델: Ollama `qwen3.5:4b` (사진을 볼 수 있는 모델, 생각 단계는 끄고 부른다)
- 의료 서비스가 아니고 아이를 평가하지 않는다. VL 모델은 **본 것을 적기만** 하고 조언 문장을 만들지 않는다.

## 1. 하는 일

```
[웹] 장면 사진 1~6장(JPEG, 소리 없음) + 분석 토큰
   → POST /ai/v1/analyze
        1) 토큰 확인(HS256, iss/aud/만료/필수 클레임, 한 번만 쓰는 jti)
        2) 본문·사진 검사(크기, 장수, JPEG 여부)
        3) 대기열 → 모델 호출(Ollama) → 출력 해석 → 태그·문장 검사
        4) 관찰 기록 + 서명한 영수증(JWS) 응답
   → 웹이 영수증을 hamkke-api 에 내면 저장된다
```

- 사진은 **메모리에서만** 다룬다. 디스크에 쓰지 않고, 로그에도 남기지 않는다. 검사용으로 디코딩한 바이트는 검사 직후 0으로 덮고, 모델 호출이 끝나면 사진을 가리키는 참조를 모두 놓는다.
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
| `VL_MODEL` | `qwen3.5:4b` | 모델 이름. 영수증의 `mv` 로 나간다 |
| `VL_MAX_CONCURRENCY` | `1` | 동시에 모델을 부르는 수 |
| `VL_MAX_WAITING` | `2` | 기다릴 수 있는 요청 수. 넘으면 429 `BUSY` |
| `VL_TIMEOUT_MS` | `180000` | 요청 하나의 제한 시간(대기 + 모델 호출 두 번까지 합쳐서) |
| `VL_MAX_WAIT_MS` | `VL_TIMEOUT_MS` 의 절반 | 차례를 기다리는 시간의 상한. 넘으면 429 `BUSY`(토큰은 되돌린다). `VL_TIMEOUT_MS` 보다 클 수 없다 |
| `VL_KEEP_ALIVE` | (Ollama 기본값 5분) | 모델을 메모리에 두는 시간. 예: `30m`(권장, compose 기본값), `-1`(내리지 않음) |
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
- **영수증 `mv` 와 응답 `modelVersion` 에는 실제로 관찰 기록을 쓴 모델 이름**이 들어간다. 로그 한 줄에 `"fallback":true` 가 붙고, 넘어갈 때마다 `fallback_model_used`(첫 모델이 실패한 짧은 코드) 로그가 남는다.
- 건강 확인의 `modelReady` 는 둘 가운데 하나라도 쓸 수 있으면 `true` 이고, 응답에 `fallbackModel` 이 붙는다.
- 대신 쓰는 모델도 같은 프롬프트(`obs-v1`)와 같은 검사를 거친다. 사진이 다른 회사의 서버로 나가는 제공자는 붙이지 않는다(10장).

## 3. API

### `POST /ai/v1/analyze`

`Authorization: Bearer <분석 토큰>`, `Content-Type: application/json`

```json
{ "frames": [ { "t": 12.5, "jpeg": "<base64>" } ], "durationSec": 95 }
```

| 항목 | 제한 |
|---|---|
| 본문 전체 | 2MB(2,097,152바이트) 이하. `Content-Length` 로 먼저 보고, 읽으면서도 센다 |
| 사진 장수 | 1~6장 |
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
  "promptVersion": "obs-v1",
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
| 502 | `MODEL_UNAVAILABLE` | 모델 서버에 닿지 못함, 또는 두 번 불러도 쓸 수 있는 출력이 없음 |
| 504 | `MODEL_TIMEOUT` | 제한 시간을 넘김 |
| 404 | `NOT_FOUND` | 모르는 주소 |
| 405 | `METHOD_NOT_ALLOWED` | 주소는 맞지만 방식이 다름(`Allow` 헤더) |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `Content-Type` 이 `application/json` 이 아님 |
| 500 | `INTERNAL_ERROR` | 그 밖의 오류 |
| 401 | `UNAUTHORIZED` | `GET /ai/v1/metrics` 에 `METRICS_TOKEN` 과 맞는 Bearer 토큰이 없음(`WWW-Authenticate: Bearer`) |

아래 다섯 줄(404·405·415·500, 지표의 401)은 공통 명세에 없는 상황에 쓰는 코드다.

토큰이 쓰인 것으로 기억되는 때는 **검사를 모두 지나 대기열에 들어간 순간**이다. 400·413·415·429 로 거절된 요청의 토큰은 다시 쓸 수 있고, 모델을 부른 뒤 502·504 로 끝난 요청의 토큰은 다시 쓸 수 없다(새 토큰을 받는다).

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
| `hamkke_ai_model_calls_total{result}` | counter | 모델 호출 결과: `ok`, `bad_output`, `unavailable`, `timeout`, `aborted`(한 요청이 두 번 부를 수 있다) |
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
   - 줄바꿈·제어 문자를 지우고 공백을 하나로 줄인다.
   - **문장 검사에 걸리면 그 글 전체를 버린다**(`summary` 는 `null`, 그 `moment` 는 제거). 목록은 `server/src/wording.ts` 한 곳에 있다: 표현 규칙 검수 스크립트와 같은 금지 표현, 그리고 평가·분류·원인 추정·조언처럼 읽히는 말(`문제`, `장애`, `이상`, `정상`, `비정상`, `지연`, `부족`, `산만`, `공격`, `과잉`, `결핍`, `의심`, `해야`, `하세요`, `바랍니다`, `권장`).
   - 한글이 없거나 한자·가나가 섞인 글은 버린다.
   - 길이: `summary` 는 3문장·300자, `note` 는 120자. 되도록 문장 단위로 줄인다.
4. `moments`: `t` 를 보낸 사진 시각 가운데 가장 가까운 값으로 맞추고, 시각 순서로 4개까지.
5. 남은 것이 하나도 없으면(문장도 태그도 순간도 없음) 쓸 수 없는 출력이다.

쓸 수 없는 출력이나 연결 실패는 **한 번 더** 불러 보고, 그래도 안 되면 502 `MODEL_UNAVAILABLE` 로 응답한다(빈 기록을 돌려주지 않는다).

공통 명세보다 조금 더 엄격하게 본 것(모두 '버리는' 쪽이라 hamkke-api 의 두 번째 검사와 어긋나지 않는다):

- 해요체가 아닌 문장('~습니다', '~한다'로 끝나는 문장)은 그 문장만 뺀다.
- 나이 표기(예: '5살', '세 살')나 생김새를 평가하는 말이 들어간 글은 버린다. 명세는 프롬프트에서 막으라고만 했다.
- `peopleCount` 가 0 이면 태그와 `moments` 를 비운다(사람이 없는 장면).
- 시각이 달라도 같은 말을 되풀이한 `moment` 는 처음 것만 남긴다.

## 7. 프롬프트 `obs-v1`

`server/src/prompt.ts`. 한국어 지시문 + 요청문 + JSON 스키마(Ollama `format`)로 이루어진다.

- 보이는 것만 시간 순서대로, 해요체로 짧게.
- 사람은 '아이', '어른'이라고만 부른다. 이름, 나이, 생김새·옷차림에 대한 느낌을 쓰지 않는다.
- 까닭을 짐작하지 않고, 조언하지 않고, 아이나 어른을 평가하거나 이름 붙이지 않는다.
- 태그는 목록의 값만, 분명히 보일 때만.
- 아이가 보이지 않으면 그렇다고만 적고 태그와 `moments` 는 비운다.
- 요청문에 사진마다 시각을 적어 준다(`- 사진 2: t=12.5`). 스키마의 `moments[].t` 는 그 시각들만 허용한다.

지시문·태그·스키마를 바꾸면 `PROMPT_VERSION` 을 올린다(`obs-v2` …). 영수증의 `pv` 로 저장되므로 어떤 지시문으로 쓴 기록인지 나중에 가릴 수 있다.

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

## 11. 걸리는 시간 (2026-11-13, 개발 기기, GPU 없이 CPU 로만)

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

`server/src/wording.ts` 는 문장 검사에 쓰려고 금지 표현 목록을 담고 있어서 표현 규칙 검수에서 이 파일 하나만 뺀다. 두 목록이 같은지는 `server/test/wording.test.ts` 가 확인한다.
