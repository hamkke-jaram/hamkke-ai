"""Tune one language MLP in the original Qwen3.5-4B and verify a reloaded PEFT adapter."""
import argparse
import hashlib
import json
import os
import time
from pathlib import Path

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TOKENIZERS_PARALLELISM"] = "false"
os.environ["HF_HUB_DISABLE_PROGRESS_BARS"] = "1"

import torch
import torch.nn.functional as F
from peft import LoraConfig, PeftModel, get_peft_model
from safetensors.torch import load_file
from transformers import AutoTokenizer, Qwen3_5ForConditionalGeneration
from importlib.metadata import version

HERE = Path(__file__).resolve().parent
DATA = HERE.parent
MODEL_ID = "Qwen/Qwen3.5-4B"
SYSTEM = "무음 장면에 대한 관찰을 검토합니다. 주어진 근거로 주장을 뒷받침할 수 있으면 A, 그렇지 않으면 B로만 답하세요."
INDEPENDENT_SHA = "eb673cb7a77a8dfe47f2d61c099f898608eb6368fd9c44f835d84ed46a30b890"


def read_rows(path, expected_sha):
    data = path.read_bytes()
    assert hashlib.sha256(data).hexdigest() == expected_sha
    return [json.loads(line) for line in data.decode("utf-8-sig").splitlines() if line]


def save(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def rows_with_scores(items, before, after):
    # Use the same ordered A,B argmax as scores(), including genuine bfloat16 ties.
    return [dict(**r, baseKeep=b.argmax().item()==0, adapterKeep=a.argmax().item()==0,
                 baseAB=b.tolist(), adapterAB=a.tolist()) for r,b,a in zip(items,before,after)]


def scores(logits, items):
    decisions = logits.argmax(1).tolist()
    correct = [prediction == (0 if row["keep"] else 1) for prediction, row in zip(decisions, items)]
    return {
        "correct":sum(correct), "n":len(items),
        "supportedKept":sum(ok and row["keep"] for ok,row in zip(correct,items)),
        "supportedTotal":sum(row["keep"] for row in items),
        "unsupportedRejected":sum(ok and not row["keep"] for ok,row in zip(correct,items)),
        "unsupportedTotal":sum(not row["keep"] for row in items),
        "byKind":{k:{"correct":sum(ok for ok,row in zip(correct,items) if row["kind"] == k),
                     "n":sum(row["kind"] == k for row in items)} for k in sorted({r["kind"] for r in items})}
    }


def encode_prompt(tok, row):
    user = "근거: " + row["evidence"] + "\n주장: " + row["claim"]
    text = tok.apply_chat_template([{"role":"system","content":SYSTEM},{"role":"user","content":user}],
        tokenize=False, add_generation_prompt=True, enable_thinking=False)
    return tok.encode(text, add_special_tokens=False)


def features(model, tok, encoded, batch, device):
    # Cache the actual MLP input and pre-normalization residual only at the location
    # whose next-token decision is supervised. Earlier weights are frozen.
    text = model.model.language_model
    cache = {}

    def remember(name):
        def save_tensor(_module, values):
            cache[name] = values[0][:,-1].to(device="cpu",dtype=torch.float32).clone()
        return save_tensor

    hooks = [text.layers[-1].mlp.down_proj.register_forward_pre_hook(remember("mlpIn")),
             text.norm.register_forward_pre_hook(remember("preNorm"))]
    order = sorted(range(len(encoded)), key=lambda i:len(encoded[i]))
    outputs = {k:[] for k in ("mlpIn", "preNorm")}
    started = time.monotonic()
    try:
        with torch.no_grad():
            for offset in range(0,len(order),batch):
                ids = order[offset:offset+batch]
                pack = tok.pad({"input_ids":[encoded[i] for i in ids]},padding=True,return_tensors="pt")
                pack = {k:v.to(device) for k,v in pack.items()}
                model.model(**pack,use_cache=False)
                for k in outputs:
                    outputs[k].append(cache[k])
                if offset == 0 or offset//batch % 8 == 0:
                    print("features",offset+len(ids),"/",len(order),"seconds",round(time.monotonic()-started,1),flush=True)
    finally:
        for hook in hooks:
            hook.remove()
    inverse = torch.tensor(order).argsort()
    return [torch.cat(outputs[k])[inverse] for k in ("mlpIn", "preNorm")]


def direct_check(model, tok, encoded, labels, device, batch):
    logits = []
    with torch.no_grad():
        for start in range(0,len(encoded),batch):
            ids = encoded[start:start+batch]
            pack = tok.pad({"input_ids":ids},padding=True,return_tensors="pt")
            pack = {k:v.to(device) for k,v in pack.items()}
            logits.append(model(**pack, use_cache=False, logits_to_keep=1).logits[:,-1,labels].float().cpu())
    return torch.cat(logits)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir",type=Path,required=True)
    parser.add_argument("--device",choices=["cpu","cuda"],default="cpu")
    parser.add_argument("--batch",type=int,default=4)
    parser.add_argument("--threads",type=int,default=4)
    args = parser.parse_args()
    torch.manual_seed(7441)
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    started = time.monotonic()
    rev = "851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a"
    lock = json.loads((DATA/"data-lock.json").read_text("utf-8-sig"))
    train = read_rows(DATA/"train.jsonl",lock["trainSha256"])
    held = read_rows(DATA/"heldout.jsonl",lock["heldoutSha256"])
    independent = read_rows(DATA/"public-data/independent-test.jsonl",INDEPENDENT_SHA)
    train_scene = {r["evidence"] for r in train}
    assert not train_scene.intersection(r["evidence"] for r in held+independent)
    assert len({r["group"] for r in independent}) == 10
    items = train + held + independent
    print("loading",MODEL_ID,rev,args.device,flush=True)
    tok = AutoTokenizer.from_pretrained(args.model_dir,local_files_only=True)
    tok.padding_side = "left"
    model = Qwen3_5ForConditionalGeneration.from_pretrained(args.model_dir,
        local_files_only=True,dtype=torch.bfloat16,attn_implementation="sdpa").eval()
    model.requires_grad_(False)
    text = model.model.language_model
    if args.device == "cuda":
        # Keep the vision tower and unused multi-token predictor off GPU. The text
        # backbone and tied output embeddings are required for ordinary label scoring.
        text.to("cuda")
        model.lm_head.to("cuda")
    label_ids = [tok.encode(x,add_special_tokens=False) for x in ("A","B")]
    assert all(len(ids)==1 for ids in label_ids)
    label_ids = [ids[0] for ids in label_ids]
    encoded = [encode_prompt(tok,r) for r in items]
    print("ready",len(train),len(held),len(independent),"max tokens",max(map(len,encoded)),flush=True)
    x, base_residual = features(model,tok,encoded,args.batch,args.device)
    n = len(train)
    hidden = text.config.hidden_size
    rank,alpha = 4,8
    scale = alpha/rank
    norm_w = (text.norm.weight.detach().float().cpu()+1)
    eps = text.norm.eps
    head = model.lm_head.weight.detach()[label_ids].float().cpu()
    def logits(residual):
        normal = residual*torch.rsqrt(residual.square().mean(1,keepdim=True)+eps)*norm_w
        return F.linear(normal,head)
    y = torch.tensor([0 if r["keep"] else 1 for r in train])
    A = torch.nn.Linear(x.size(1),rank,bias=False)
    B = torch.nn.Linear(rank,hidden,bias=False)
    B.weight.data.zero_()
    opt = torch.optim.AdamW([A.weight,B.weight],lr=4e-4,weight_decay=0.01)
    history=[]
    for epoch in range(16):
        for ix in torch.randperm(n).split(24):
            loss = F.cross_entropy(logits(base_residual[ix]+B(A(x[ix]))*scale),y[ix])
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_([A.weight,B.weight],2.0)
            opt.step()
        with torch.no_grad():
            history.append(float(F.cross_entropy(logits(base_residual[:n]+B(A(x[:n]))*scale),y)))
    lookup = "model.language_model.layers."+str(len(text.layers)-1)+".mlp.down_proj"
    cfg = LoraConfig(r=rank,lora_alpha=alpha,lora_dropout=0.0, bias="none",
                     target_modules=[lookup],task_type="CAUSAL_LM")
    # Evaluate actual model with and without the adapter, rather than assigning
    # credit based solely on cached approximations of bfloat16 arithmetic.
    test_before = direct_check(model,tok,encoded[n:],label_ids,args.device,args.batch)
    wrapped = get_peft_model(model,cfg)
    mod = text.layers[-1].mlp.down_proj
    mod.lora_A.default.weight.data.copy_(A.weight)
    mod.lora_B.default.weight.data.copy_(B.weight)
    out = HERE/"adapter"
    wrapped.save_pretrained(out,safe_serialization=True,save_embedding_layers=False)
    config = json.loads((out/"adapter_config.json").read_text())
    config.update(base_model_name_or_path=MODEL_ID,revision=rev)
    save(out/"adapter_config.json",config)
    weights = load_file(out/"adapter_model.safetensors")
    assert len(weights)==2 and all(w.abs().max()>0 for w in weights.values())
    restored = PeftModel.from_pretrained(wrapped.unload(),out,is_trainable=False).eval()
    actual = direct_check(restored,tok,encoded[n:],label_ids,args.device,args.batch)
    h=len(held)
    with torch.no_grad():
        train_before=logits(base_residual[:n])
        train_after=logits(base_residual[:n]+scale*B(A(x[:n])))
    result = {"model":MODEL_ID,"revision":rev,"languageLayer":lookup,"rank":rank,"alpha":alpha,
        "adapterSha256":hashlib.sha256((out/"adapter_model.safetensors").read_bytes()).hexdigest(),
        "trainableParameters":sum(w.numel() for w in weights.values()),"inputDevice":args.device,"dtype":"bfloat16",
        "torch":torch.__version__,"transformers":version("transformers"),"peft":version("peft"),
        "labelTokenIds":label_ids,"trainingObjective":"Conditional next-token cross-entropy over A/B for a Korean observation claim",
        "trainDataSha256":lock["trainSha256"],"independentDataSha256":INDEPENDENT_SHA,
        "outputWeightsReloaded":True,"updateSteps":16*((n+23)//24),"seed":7441,"lossByEpoch":history,
        "baselineTrain":scores(train_before,train),"adapterTrain":scores(train_after,train),
        "heldout":{"base":scores(test_before[:h],held),"adapter":scores(actual[:h],held)},
        "independent":{"base":scores(test_before[h:],independent),"adapter":scores(actual[h:],independent)},
        "elapsedSecs":round(time.monotonic()-started,1),"license":"Apache-2.0"}
    save(HERE/"result.json",result)
    save(HERE/"predictions.json",rows_with_scores(held+independent,test_before,actual))
    print("RESULT",json.dumps({k:result[k] for k in ("heldout","independent","elapsedSecs")},ensure_ascii=False),flush=True)


if __name__ == "__main__":
    main()
