# 한국어 관찰 문장의 근거 판단 실험

시각적 근거를 글로 제시한 뒤 후보 문장을 그 근거에서 확인할 수 있는지 A/B로 답하도록 LoRA 어댑터 두 개를 학습했다. 교사가 검토하는 서비스의 RAG 추천은 별도 코드와 근거 DB를 사용한다.

| 기반 모델 | 어댑터 | 보류 주장 48개, 학습 전 → 후 | 별도 주장 22개, 학습 전 → 후 |
| --- | --- | --- | --- |
| Qwen2.5-0.5B-Instruct | [출력층 LoRA](MODEL-CARD.md) | 31 → 35 | 18 → 20 |
| Qwen3.5-4B | [언어부 마지막 MLP LoRA](four-b/README.md) | 45 → 46 | 21 → 22 |

학습 데이터는 COCO Consortium의 영어 캡션 101개를 바탕으로 만든 한국어 주장 202개, 직접 작성한 상황에서 만든 주장 96개로 구성했다. 공개 캡션을 고르고 번역한 뒤 관찰 가능한 행동 중심으로 정리했다. [캡션 출처와 변경 내역](public-data/manifest.json) · [COCO 이용조건](https://cocodataset.org/dataset/termsofuse.htm) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)

## 파일 검증

이 폴더에서 `python verify_package.py`를 실행하면 표준 라이브러리만으로 두 어댑터의 SHA-256, 학습·시험 데이터 해시, 저장된 판정과 요약 수치의 일치를 검사한다. `python make_data.py`로 배포된 캡션과 작성 예시에서 학습·보류 JSONL을 다시 생성할 수 있다. 영문 주석과 번역 쌍을 공식 배포본에서 재구성하는 명령은 `python public-data/prepare_coco.py`다.

모델 실행에는 Python, PyTorch, Transformers, PEFT, safetensors와 해당 모델 카드에 명시된 공식 체크포인트가 필요하다. 학습 스크립트는 각 `adapter` 폴더와 결과 JSON에 다시 쓴다. 학습을 재현할 때는 실험 폴더의 복사본에서 실행한다.
