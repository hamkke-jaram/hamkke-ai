# 지표 정의서 `metrics-v1`

AI ↔ 프런트 ↔ 백엔드의 약속 문서. 계산은 **모두 부모 폰의 브라우저 안에서** 끝나고, 서버에는 아래 JSON만 간다.

## 1. 입력과 전처리

| 항목 | 값 |
|---|---|
| 입력 | 폰으로 찍은 영상 1개(권장 1~3분, 최대 30분). 폰을 세워 두고 부모와 아이가 함께 화면에 나오게 촬영 |
| 영상 프레임 | 0.5초 간격(2fps) 샘플링, 긴 변 640px로 축소 후 분석 |
| 자세 모델 | MediaPipe Pose Landmarker **lite**(float16), `numPoses=2`, VIDEO 모드, GPU 실패 시 CPU |
| 오디오 | 영상의 오디오 트랙을 `AudioContext.decodeAudioData`로 디코딩 → 모노 → 16kHz |
| 오디오 프레임 | 40ms 창, 20ms 이동. RMS(dB) + 자기상관 기반 기본 주파수(F0, 75~700Hz) |
| 소리 있는 구간 | dB > (하위 20% 분위 dB + 10dB) 이고 F0 신뢰도(정규화 자기상관) ≥ 0.5 |
| 화자 구분(추정) | F0 ≥ 280Hz → 아이, 85~255Hz → 어른, 그 사이 → 구분 안 함 |
| 구간 묶기 | 같은 화자 프레임 사이 공백 ≤ 200ms면 이어 붙이고, 200ms 미만 구간은 버림 |

> 화자 구분은 음높이만 쓰는 추정이다. 목소리가 높은 어른이나 낮은 아이는 섞일 수 있다. 그래서 이 지표는 **같은 가정의 시간에 따른 변화**를 보는 용도로만 쓰고, 다른 가정과 비교하지 않는다.

## 2. 지표 3개

### ① 함께 노는 시간 `jointPlaySeconds`

| 항목 | 정의 |
|---|---|
| 의미 | 부모와 아이가 한 화면에 가까이 함께 있었던 시간 |
| 단위 | 초(소수 1자리) |
| 계산 | 샘플 프레임마다 사람 2명이 검출되고, 두 사람 몸통 중심(양 어깨·양 엉덩이 평균) 사이 거리 ≤ 두 사람 평균 몸통 길이 × 2.5 이면 "함께" 프레임. 함께 프레임 수 × 0.5초. 한 프레임짜리 끊김(앞뒤가 함께)은 함께로 메움 |
| 화면 표시 | "함께한 시간 ○분 ○초" 와 분석 길이 대비 비율 |

### ② 부모 반응 시간 `responseLatencySec`

| 항목 | 정의 |
|---|---|
| 의미 | 아이가 소리를 낸 뒤 부모 목소리가 이어지기까지 걸린 시간 |
| 단위 | 초(소수 2자리), 중앙값 |
| 아이 발화(`childBidCount`) | 아이 구간 중 길이 ≥ 300ms 인 것 (울음 구간 제외) |
| 반응(`respondedBidCount`) | 아이 발화가 끝난 뒤 5초 안에 시작한 첫 어른 구간. 어른 구간이 아이 발화 도중 시작했으면 지연 0초 |
| 값 | 반응된 발화들의 지연 중앙값. 반응된 발화가 3개 미만이면 `null`("이번 영상에선 측정이 어려웠어요") |

### ③ 울음·감정 폭발 횟수 `distressEpisodeCount`

| 항목 | 정의 |
|---|---|
| 의미 | 아이가 크게, 길게 운 횟수 |
| 단위 | 회 |
| 계산 | 아이 구간 중 평균 dB ≥ (바닥 dB + 25dB) 이고 길이 ≥ 1.5초(내부 공백 ≤ 500ms 허용)인 구간. 앞 구간 끝과 3초 이내로 붙으면 한 번으로 셈 |

## 3. 전송 JSON

`POST /api/v1/children/{childId}/interaction-records`

```json
{
  "clientRecordId": "1f0c7b1e-5a1d-4c5e-9a55-0b8f6f5f2d10",
  "recordedAt": "2026-11-06T09:30:00Z",
  "analyzedSeconds": 182.5,
  "jointPlaySeconds": 121.0,
  "responseLatencySec": 1.42,
  "childBidCount": 14,
  "respondedBidCount": 11,
  "distressEpisodeCount": 1,
  "modelVersion": "pose_landmarker_lite@0.10.22+audio-heuristic-1",
  "specVersion": "metrics-v1"
}
```

| 필드 | 타입 | 규칙 |
|---|---|---|
| clientRecordId | UUID | 기기에서 생성. 재전송 시 같은 값 |
| recordedAt | ISO-8601 | 영상 파일의 수정 시각(없으면 분석 시각). 미래 불가 |
| analyzedSeconds | number | 10 ~ 1800 |
| jointPlaySeconds | number | 0 ~ analyzedSeconds |
| responseLatencySec | number \| null | 0 ~ 10 |
| childBidCount | int | 0 ~ 2000 |
| respondedBidCount | int | 0 ~ childBidCount |
| distressEpisodeCount | int | 0 ~ 200 |
| modelVersion | string | 1~100자 |
| specVersion | string | `metrics-v1` |

## 4. 버전 규칙

계산 방법이 바뀌면 `specVersion`을 올리고(`metrics-v2`), 백엔드 지원 목록에 추가한다. 서로 다른 버전의 값은 변화 추이 계산에서 섞지 않는다(기준값은 같은 `specVersion` 기록만 사용).

## 5. 정확도 확인 방법 (내부용)

팀원 연출 영상 10개 이상에서 사람이 스톱워치로 잰 값과 비교해 차이를 기록한다. 결과는 내부 개선용이며, 앱·발표 자료에 "정확도 ○○%" 같은 수치로 쓰지 않는다.
