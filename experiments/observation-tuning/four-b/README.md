# Qwen3.5-4B 한국어 관찰 근거 판단 어댑터

공식 `Qwen/Qwen3.5-4B`의 시각·언어 모델 가중치를 읽고 언어부 32번째 층의 `mlp.down_proj`에 rank 4, alpha 8인 LoRA를 적용한다. 모델이 받는 입력은 한국어로 쓴 장면 근거와 후보 문장이다. 답은 근거가 있으면 A, 부족하면 B인 제한된 두 토큰 중 하나다. `enable_thinking=False`인 공식 대화 양식을 사용한다. 학습 대상은 언어 판단이며 영상을 직접 보고 사람 수를 세는 모델의 능력은 이 훈련에서 측정하지 않는다. [공식 모델과 Apache 2.0 라이선스](https://huggingface.co/Qwen/Qwen3.5-4B) · [LoRA 명세](https://huggingface.co/docs/peft/en/package_reference/lora)

## 실제 학습 결과

2026년 11월 20일 CPU에서 학습 주장 298개를 사용해 저차 가중치 47,104개를 208번 갱신했다. 첫 에폭의 교차엔트로피는 0.1190, 마지막은 0.0051이었다. 실제 파일을 다시 불러와 판정한 결과는 다음과 같다.

| 한국어 텍스트 판정 | 원본 4B | 파인튜닝한 4B |
|---|---:|---:|
| 학습에 쓰지 않은 12장면, 전체 | 45/48 | 46/48 |
| 이 중 맞는 동작을 보존 | 23/24 | 22/24 |
| 이 중 틀린 주장을 거절 | 22/24 | 24/24 |
| 별도 제작한 10장면, 전체 | 21/22 | 22/22 |
| 이 중 맞는 동작을 보존 | 12/12 | 12/12 |
| 이 중 틀린 주장을 거절 | 9/10 | 10/10 |

두 평가 모두 소수의 문장 차이로 전체 점수가 올랐다. 첫 평가에서는 한 행동을 더 놓쳤다. 근거가 정확한 텍스트에서 주장 채택 여부를 측정한 결과로, 시각 모델이 처음부터 잘못 기록한 장면 근거의 오류는 측정하지 않았다. [수치 및 환경](./result.json) · [70개 행의 판정](./predictions.json) · [어댑터 가중치](./adapter/adapter_model.safetensors)

## 재현

저장소의 `experiments/observation-tuning`에서 아래 명령을 실행한다. 공식 리비전의 모델 샤드와 토크나이저를 받아 두고, 학습할 때는 로컬 파일을 읽는다. 원래 실행 환경은 PyTorch 2.12.0.dev20260408+cu128(CPU 실행), Transformers 5.9.0, PEFT 0.19.1이다.

```powershell
hf download Qwen/Qwen3.5-4B --revision 851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a --local-dir weights/qwen4b
python four-b/train.py --model-dir weights/qwen4b --device cpu --batch 4 --threads 4
```

가중치가 고정된 층들은 한 번 통과시켜 마지막 토큰의 중간 벡터를 계산한다. 저차 행렬 두 개는 근거 판정의 두 토큰 사이 교차 엔트로피 경사를 사용해 실제로 업데이트한다. 훈련 후 Hugging Face PEFT 형식으로 어댑터를 저장하고 다시 불러와, 보류 주장과 독립 주장의 전체 모델 출력을 원본 모델과 비교한다. 메모리에 있는 중간 벡터의 점수는 학습 집합 진단에만 쓴다. [학습 코드](./train.py)

## 학습 자료와 이용 조건

영문 COCO Captions 주석의 원저작자는 **COCO Consortium**이며 주석의 라이선스는 **CC BY 4.0**이다. 공개 주석에서 고른 101개 장면의 보이는 행동을 한국어로 옮기고 주체·동작 판단 문제로 변환했다. 프로젝트가 작성한 별도 장면도 학습에 포함한다. 실제 사진과 서비스의 아동 영상을 학습 입력으로 사용하지 않는다. COCO Consortium과 Qwen은 이 프로젝트의 훈련 결과를 보증하지 않는다. [COCO 원자료](https://cocodataset.org/#download) · [원자료 조건](https://cocodataset.org/dataset/termsofuse.htm) · [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) · [표본 ID와 변경 내역](../public-data/manifest.json)

별도 수기 평가 10장면에는 실제 상호작용, 같은 공간에서 서로 다른 행동, 소리 없이 볼 수 있는 시선 변화, 확인할 수 없는 대화가 들어 있다. 전체 22개 주장에 대한 답을 모델 출력 확인 전에 고정했다. 독립 평가의 규모와 두 토큰 과제 특성을 감안해 해석해야 한다. [독립 평가](../public-data/independent-test.jsonl)

## 저장된 어댑터로 판정하기

`four-b` 폴더에서 아래와 같이 실행한다. 실제 사용 시 장면 근거와 판단할 주장을 각각 넣는다. 어떤 사람이 무엇을 했는지에 관한 근거는 호출자가 제공해야 한다.

```python
from pathlib import Path
import torch
from peft import PeftModel
from transformers import AutoTokenizer, Qwen3_5ForConditionalGeneration
from train import encode_prompt, direct_check

weights = Path("../weights/qwen4b")
tokenizer = AutoTokenizer.from_pretrained(weights, local_files_only=True)
tokenizer.padding_side = "left"
base = Qwen3_5ForConditionalGeneration.from_pretrained(
    weights, local_files_only=True, dtype=torch.bfloat16, attn_implementation="sdpa"
)
judge = PeftModel.from_pretrained(base, "adapter", is_trainable=False).eval()
row = {"evidence": "아이가 의자에 앉아 종이 한 장을 펼친다.", "claim": "아이가 종이를 펴요."}
labels = [tokenizer.encode(label, add_special_tokens=False)[0] for label in ("A", "B")]
logits = direct_check(judge, tokenizer, [encode_prompt(tokenizer, row)], labels, "cpu", 1)
print("근거 있음" if logits.argmax().item() == 0 else "근거 부족")
```
