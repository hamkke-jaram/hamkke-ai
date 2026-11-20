---
base_model: Qwen/Qwen2.5-0.5B-Instruct
license: apache-2.0
library_name: peft
language: [ko]
tags: [lora, text-generation]
---

# 한국어 관찰 문장 보정 실험용 LoRA

시각 근거를 적은 한국어 문장과 하나의 후보 주장을 입력하면, 근거가 뒷받침하는 주장은 A, 보류할 주장은 B로 판정한다. 영상 서비스와 별도로 보관하는 실험용 텍스트 모델이다. 근거 문장을 작성하는 사람이나 영상 모델이 놓친 장면은 복구할 수 없다.

## 학습 데이터와 모델

COCO Consortium의 2017 훈련용 사람 행동 주석 중 서로 다른 사진 ID의 101개를 골라 한국어로 옮기고 화면에서 확인되는 행동에 집중했다. 각 주석에 하나의 긍정 주장과 하나의 새로 작성한 대화 오답을 연결했다. 공식 주석은 CC BY 4.0이며 사진은 내려받지 않았다. 별도로 새로 작성한 24개 장면의 96개 주장까지 학습 298개다. 서비스 이용자 기록과 임상 평가 원본 67편은 학습에서 제외했다. [COCO 이용 조건](https://cocodataset.org/dataset/termsofuse.htm) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

Apache 2.0으로 공개한 Qwen2.5-0.5B-Instruct의 언어 출력층에 rank 4, alpha 8 LoRA를 학습했다. A/B 두 출력 토큰 간 조건부 교차 엔트로피를 줄이는 방식으로 CPU에서 250회 최적화했다. PEFT 가중치는 2,445,560바이트이고 SHA-256은 `5b87c8eec65b5df5809f018e5e04ac3040ed3929bbd2444c079934b5db588d47`이다. 기반 모델 리비전은 `7ae557604adf67be50417f59c2c2f167def9a775`이다. 이 어댑터는 원 모델의 공유 입력 임베딩을 그대로 두고 출력층에서만 적용하도록 학습했다. 검증한 배포 형식은 기반 모델에 PEFT 어댑터를 별도로 로드하는 방식이다. [기반 모델 카드](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct)

## 새로 작성한 한국어 상황에서의 결과

가중치를 저장한 뒤 새 프로세스에서 기반 모델과 어댑터 모델의 실제 BF16 출력층에 똑같은 입력 상태를 넣고 A/B 점수가 높은 답을 골랐다. 시험 데이터와 정답은 학습 전에 고정했다. 두 평가 모두 실제 임상 영상을 분석하는 정확도와는 별개의 텍스트 판별 과제다.

| 평가 단위 | 원 모델 | 학습 후 |
|---|---:|---:|
| 12개 보류 장면의 48개 주장 | 31/48 | 35/48 |
| 그중 관찰 동작을 올바르게 보존 | 9/24 | 15/24 |
| 그중 대화 거절 | 12/12 | 12/12 |
| 그중 화면에 없거나 참여자가 틀린 동작 거절 | 10/12 | 8/12 |
| 다른 작성자가 만든 별도 10개 장면의 22개 주장 | 18/22 | 20/22 |
| 별도 장면에서 근거 있는 동작 보존 | 8/12 | 10/12 |
| 별도 장면에서 근거 없는 대화·공동놀이 거절 | 10/10 | 10/10 |

일부 화면에 없는 행동을 더 자주 받아들였으므로 이 어댑터를 운영 판단에 사용하지 않았다. 작은 수기 평가 두 묶음은 새 가정 영상에서의 성능을 보장하지 않는다.

## 재현과 개별 판정

저장소의 `experiments/observation-tuning`에서 실행한다. 원래 환경은 Python 3.11.9, PyTorch 2.5.1+cu121(CPU 실행), Transformers 5.9.0, PEFT 0.19.1이다. 두 어댑터는 별도의 읽기 전용 검증도 지원한다. [실험 구성과 검증](./README.md)

```powershell
hf download Qwen/Qwen2.5-0.5B-Instruct --revision 7ae557604adf67be50417f59c2c2f167def9a775 --local-dir weights/qwen05
python make_data.py
python train.py --model-dir weights/qwen05
python check_claim.py --model-dir weights/qwen05 --evidence "사람이 두 손으로 지도 한 귀퉁이를 누른다." --claim "지도 끝을 손으로 눌러요."
```

자료 출처와 해시는 `public-data/manifest.json`과 `data-lock.json`, 시험 문항별 판정은 `heldout-predictions.json`, 저장 후 실출력 재검사는 `reload-audit.json`에 있다.
