"""Train and verify a PEFT output-head LoRA on constrained next-token supervision."""
from __future__ import annotations
import argparse
import hashlib
import json
import os
import platform
import shutil
import subprocess
import sys
import time
from collections import Counter
from pathlib import Path

os.environ['HF_HUB_OFFLINE']='1'
os.environ['TRANSFORMERS_OFFLINE']='1'
os.environ['TOKENIZERS_PARALLELISM']='false'
import torch
from peft import LoraConfig, PeftModel, get_peft_model
from safetensors.torch import load_file
from transformers import AutoModelForCausalLM, AutoTokenizer
from importlib.metadata import version

ROOT=Path(__file__).resolve().parent
MODEL='Qwen/Qwen2.5-0.5B-Instruct'
REV='7ae557604adf67be50417f59c2c2f167def9a775'
SYSTEM='무음 사진 관찰 기록을 검토해요. 근거로 확인되는 주장은 A, 확인할 수 없는 주장은 B. A 또는 B만 답하세요.'
def read(path):
    return [json.loads(x) for x in path.read_text(encoding='utf-8-sig').splitlines() if x]
def sha(path):
    digest=hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda:f.read(8*1024*1024),b''):
            digest.update(chunk)
    return digest.hexdigest()
def prompt(tok,r):
    return tok.apply_chat_template([dict(role='system',content=SYSTEM),
        dict(role='user',content=f"근거: {r['evidence']}\n주장: {r['claim']}")], tokenize=False, add_generation_prompt=True)
def targets(rows):
    return torch.tensor([0 if r['keep'] else 1 for r in rows])
def features(model,tok,rows,batch):
    encoded=[tok.encode(prompt(tok,r),add_special_tokens=False) for r in rows]
    order=sorted(range(len(rows)),key=lambda i:len(encoded[i]))
    positions=[]
    hidden=[]
    start=time.monotonic()
    with torch.inference_mode():
        for offset in range(0,len(order),batch):
            ids=order[offset:offset+batch]
            packed=tok.pad(dict(input_ids=[encoded[i] for i in ids]),padding=True,return_tensors='pt')
            last=model.model(**packed,use_cache=False).last_hidden_state
            ends=packed['attention_mask'].sum(-1)-1
            hidden.append(last[torch.arange(len(ids)),ends].float().cpu())
            positions+=ids
            if offset==0 or (offset//batch)%10==0:
                print('encoded',offset+len(ids),'/',len(order),'sec',round(time.monotonic()-start,1),flush=True)
    return torch.cat(hidden)[torch.tensor(positions).argsort()].clone()
def score(logits,rows):
    preds=logits.argmax(-1).tolist()
    correct=[i==(0 if r['keep'] else 1) for i,r in zip(preds,rows)]
    kinds={kind:{'correct':sum(ok for ok,r in zip(correct,rows) if r['kind']==kind),'n':sum(r['kind']==kind for r in rows)}
           for kind in sorted({r['kind'] for r in rows})}
    return {'n':len(rows),'correct':sum(correct),'accuracy':sum(correct)/len(rows),'kinds':kinds,
            'supportedKept':sum(r['keep'] and ok for r,ok in zip(rows,correct)),
            'supportedTotal':sum(bool(r['keep']) for r in rows),
            'unsupportedRejected':sum(not r['keep'] and ok for r,ok in zip(rows,correct)),
            'unsupportedTotal':sum(not r['keep'] for r in rows)}

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--model-dir',type=Path,required=True)
    p.add_argument('--batch',type=int,default=6)
    p.add_argument('--threads',type=int,default=5)
    p.add_argument('--independent-only',action='store_true')
    args=p.parse_args()
    if args.independent_only:
        subprocess.run([sys.executable,str(ROOT/'check_claim.py'),'--audit','--model-dir',str(args.model_dir)],check=True)
        return
    torch.set_num_threads(args.threads)
    torch.set_num_interop_threads(1)
    torch.manual_seed(1307)
    start=time.monotonic()
    lock=json.loads((ROOT/'data-lock.json').read_text(encoding='utf-8'))
    for group in ['train','heldout']:
        assert sha(ROOT/f'{group}.jsonl')==lock[group+'Sha256']
    train,held=(read(ROOT/f'{name}.jsonl') for name in ['train','heldout'])
    tok=AutoTokenizer.from_pretrained(args.model_dir,local_files_only=True)
    tok.padding_side='right'
    labelids=[]
    for label in ['A','B']:
        span=tok.encode(label,add_special_tokens=False)
        assert len(span)==1
        labelids+=span
    dtype=torch.bfloat16 if getattr(torch.cpu,'_is_avx512_bf16_supported',lambda:False)() else torch.float32
    model=AutoModelForCausalLM.from_pretrained(args.model_dir,local_files_only=True,dtype=dtype,attn_implementation='sdpa').eval()
    model.requires_grad_(False)
    print('loaded',dtype,'threads',args.threads,'A/B',labelids,flush=True)
    weight=model.lm_head.weight.detach()[labelids].float()
    def verify_reload(test_rows,saved):
        samples=test_rows[:8]
        h=features(saved.base_model.model,tok,samples,args.batch)
        summaries={}
        with torch.inference_mode():
            logits=saved.base_model.model.lm_head(h.to(dtype)).float()[:,labelids]
        return logits,summaries
    n=len(train)
    allrows=train+held
    h=features(model,tok,allrows,args.batch)
    base=(h@weight.T).detach()
    # Only two tokens are legal for this task. Optimizing their two rows is exactly
    # conditional next-token cross entropy under this constraint. All other LoRA B rows
    # remain zero when we serialize the full PEFT layer.
    dim=weight.size(1)
    rank=4
    alpha=8
    scale=alpha/rank
    proj=torch.nn.Linear(dim,rank,bias=False)
    out=torch.nn.Linear(rank,2,bias=False)
    torch.nn.init.zeros_(out.weight)
    opt=torch.optim.AdamW([proj.weight,out.weight],lr=0.002,weight_decay=0.02)
    y=targets(train)
    hist=[]
    for epoch in range(25):
        for ix in torch.randperm(n).split(32):
            logits=base[ix]+out(proj(h[ix]))*scale
            loss=torch.nn.functional.cross_entropy(logits,y[ix])
            opt.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_([proj.weight,out.weight],3)
            opt.step()
        with torch.no_grad():
            hist.append(float(torch.nn.functional.cross_entropy(base[:n]+out(proj(h[:n]))*scale,y)))
    with torch.no_grad():
        tuned=base+out(proj(h))*scale
    cfg=LoraConfig(r=rank,lora_alpha=alpha,lora_dropout=0.0,bias='none',target_modules=['lm_head'],task_type='CAUSAL_LM')
    wrapped=get_peft_model(model,cfg)
    head=wrapped.base_model.model.lm_head
    with torch.no_grad():
        head.lora_A.default.weight.copy_(proj.weight)
        head.lora_B.default.weight.zero_()
        head.lora_B.default.weight[labelids]=out.weight.to(head.lora_B.default.weight.dtype)
        actual=head(h[-len(held):].to(dtype)).float()[:,labelids]
        assert torch.equal(actual.argmax(-1),tuned[n:].argmax(-1))
    adapter=ROOT/'adapter'
    wrapped.save_pretrained(adapter,safe_serialization=True,save_embedding_layers=False)
    cfgpath=adapter/'adapter_config.json'
    config=json.loads(cfgpath.read_text(encoding='utf-8'))
    config['base_model_name_or_path']=MODEL
    config['revision']=REV
    cfgpath.write_text(json.dumps(config,indent=2)+'\n',encoding='utf-8')
    state=load_file(adapter/'adapter_model.safetensors')
    assert len(state)==2 and all(t.abs().max()>0 for t in state.values())
    original=wrapped.unload()
    reloaded=PeftModel.from_pretrained(original,adapter,is_trainable=False).eval()
    checked,_=verify_reload(held,reloaded)
    assert torch.equal(checked.argmax(-1),actual[:len(checked)].argmax(-1))
    results={'model':MODEL,'revision':REV,'baseSafetensorsSha256':sha(args.model_dir/'model.safetensors'),
        'adapterSha256':sha(adapter/'adapter_model.safetensors'),'device':'cpu','dtype':str(dtype),'labelTokenIds':labelids,
        'method':'PEFT LoRA on lm_head; next-token cross entropy conditional on two legal completions A/B',
        'rank':rank,'alpha':alpha,'steps':25*((n+31)//32),'learningRate':0.002,'train':len(train),
        'heldout':len(held),'dataLock':lock,'trainLossFirstEpoch':hist[0], 'trainLossLastEpoch':hist[-1],
        'baselineTrain':score(base[:n],train),'adapterTrain':score(tuned[:n],train),
        'baselineHeldout':score(base[n:],held),'adapterHeldout':score(actual,held),
        'actualReloadVerifiedRows':len(checked),'torch':version('torch'),'peft':version('peft'),
        'transformers':version('transformers'),'python':platform.python_version(),
        'elapsedSec':round(time.monotonic()-start,2)}
    (ROOT/'result.json').write_text(json.dumps(results,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    (ROOT/'heldout-predictions.json').write_text(json.dumps([dict(**r,baseKeep=bool(a[0]>a[1]),adapterKeep=bool(b[0]>b[1])) for r,a,b in zip(held,base[n:],actual)],indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    shutil.copyfile(ROOT/'MODEL-CARD.md',adapter/'README.md')
    # Optimizer used FP32 features and a two-row projection. Deployment scoring uses the
    # native BF16 output heads for BOTH versions, including rounding/ties at the A/B step.
    subprocess.run([sys.executable,str(ROOT/'check_claim.py'),'--audit','--model-dir',str(args.model_dir)],check=True)
if __name__=='__main__':
    main()
