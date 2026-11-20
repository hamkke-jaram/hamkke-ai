"""Run a saved adapter offline, or independently check all recorded test predictions."""
import argparse
import json
from pathlib import Path

from train import ROOT, features, read, score, sha
import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--model-dir',type=Path,required=True)
    parser.add_argument('--evidence')
    parser.add_argument('--claim')
    parser.add_argument('--audit',action='store_true')
    args=parser.parse_args()
    if not args.audit and not (args.evidence and args.claim):
        parser.error('Supply --evidence and --claim or use --audit.')
    torch.set_num_threads(5)
    torch.set_num_interop_threads(1)
    dtype=torch.bfloat16 if getattr(torch.cpu,'_is_avx512_bf16_supported',lambda:False)() else torch.float32
    tok=AutoTokenizer.from_pretrained(args.model_dir,local_files_only=True)
    model=AutoModelForCausalLM.from_pretrained(args.model_dir,local_files_only=True,dtype=dtype,attn_implementation='sdpa').eval()
    cfg=json.loads((ROOT/'result.json').read_text(encoding='utf-8'))
    assert sha(ROOT/'adapter/adapter_model.safetensors')==cfg['adapterSha256']
    subsets=({'heldout':read(ROOT/'heldout.jsonl'),'independent':read(ROOT/'public-data/independent-test.jsonl')}
             if args.audit else {'user':[{'evidence':args.evidence,'claim':args.claim}]})
    labelids=[tok.encode(label,add_special_tokens=False)[0] for label in ['A','B']]
    rows=[row for subset in subsets.values() for row in subset]
    h=features(model,tok,rows,6)
    with torch.inference_mode():
        baseline=model.lm_head(h.to(dtype))[:,labelids].float()
    wrapped=PeftModel.from_pretrained(model,ROOT/'adapter',is_trainable=False).eval()
    with torch.inference_mode():
        tuned=wrapped.base_model.model.lm_head(h.to(dtype))[:,labelids].float()
    if not args.audit:
        print(json.dumps({'keep':bool(tuned[0].argmax()==0),'choices':['keep','withhold']},ensure_ascii=True))
        return
    offset=0
    audit={}
    independent_path=ROOT/'independent-result.json'
    independent={'sourceSha256':sha(ROOT/'public-data/independent-test.jsonl')}
    for name,subset in subsets.items():
        b,a=baseline[offset:offset+len(subset)],tuned[offset:offset+len(subset)]
        actual=score(b,subset),score(a,subset)
        audit[name]={'baseline':actual[0],'adapter':actual[1],'n':len(subset)}
        if name=='heldout':
            cfg['baselineHeldout'],cfg['adapterHeldout']=actual
            cfg['evaluationPath']='Fresh process, native BF16 base and PEFT output heads, identical hidden states, argmax over A/B'
            (ROOT/'heldout-predictions.json').write_text(json.dumps([
                dict(**r,baseKeep=bool(x.argmax()==0),adapterKeep=bool(y.argmax()==0))
                for r,x,y in zip(subset,b,a)],indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
        else:
            independent['baseline'],independent['adapter']=actual
        offset+=len(subset)
    print(json.dumps(audit))
    (ROOT/'result.json').write_text(json.dumps(cfg,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    independent_path.write_text(json.dumps(independent,indent=2,ensure_ascii=False)+'\n',encoding='utf-8')
    audit_path=ROOT/'reload-audit.json'
    if audit_path.exists():
        assert json.loads(audit_path.read_text(encoding='utf-8'))==audit
    audit_path.write_text(json.dumps(audit,indent=2)+'\n',encoding='utf-8')
if __name__=='__main__':
    main()
