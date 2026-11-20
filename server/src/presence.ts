import type { Observation } from './observation.ts';

const subject = '(아이|어른|사람)(들)?(은|는|이|가|도)?';
const location = '(?:(?:화면|영상|사진)(?:\\s*속)?(?:에는|에서는|에|에서)\\s*)?';
const negative = '(?:없(?:어요|습니다|고|으며|지만)|보이지\\s*않(?:아요|습니다|고|으며|지만)|안\\s*(?:보여요|보입니다|보이고|보이며|보이지만))';
const absence = new RegExp('^' + location + subject + '\\s*' + location + negative);
const temporal = /잠시|잠깐|한동안|때때로|그때|이때|지금|처음에는|마지막에는|순간|몇\s*초|\d\s*초|화면\s*밖|프레임\s*밖|이\s*장면|그\s*장면|이\s*시점|그\s*시점/;
const sentences = (s:string) => s.split(/(?<=[.!?…])\s+|(?<=요[.!?])(?=[가-힣])/);
const key = (s:string) => s.replace(/\s+/g,'');

function absenceClauses(sentence:string) {
  if (temporal.test(sentence)) return [];
  const starts = [0,...Array.from(sentence.matchAll(/,\s*|(?<=(?:고|며|지만))\s+/g), m=>m.index+m[0].length)];
  const clauses: {start:number; end:number; original:string; neutral:string; role:string}[] = [];
  for (const start of starts) {
    const m = absence.exec(sentence.slice(start));
    if (!m) continue;
    const end = start + m[0].length;
    const tail = sentence.slice(end);
    if (tail && !/^[\s,.!?…]/.test(tail)) continue;
    if (tail.trim() && !/^[\s,]*[.!?…]*$/.test(tail) && !/(?:고|며|지만)$/.test(m[0])) continue;
    const [match,role='',plural='',particle=''] = m;
    const after = particle === '가' ? '이' : particle === '는' ? '은' : particle;
    const neutral = match.replace(role+plural+particle, '사람'+plural+after);
    clauses.push({start,end,original:key(match),neutral:key(neutral),role});
  }
  return clauses;
}

function omitClause(sentence:string, start:number, end:number):string|null {
  const left = sentence.slice(0,start).replace(/[\s,]+$/,'');
  const right = sentence.slice(end).replace(/^[\s,.!?…]+/,'');
  if (!left) return right;
  if (right) return left + ' ' + right;
  if (/요$/.test(left)) return left+'.';
  if (/있었고$/.test(left)) return left.slice(0,-1)+'어요.';
  if (/있고$/.test(left)) return left.slice(0,-1)+'어요.';
  if (/했고$/.test(left)) return left.slice(0,-1)+'어요.';
  // A retained coordination needs its own finite ending. If its meaning
  // cannot be preserved confidently, leave the original compound intact.
  if (/고$/.test(left) && !/(?:려고|라고|자고|다고|냐고)$/.test(left)) return left+' 있어요.';
  return null;
}

function repairField(text:string|null, draft:string|null):string|null {
  if (!text || !draft || !text.includes('사람')) return text;
  const raw = sentences(draft).flatMap(absenceClauses);
  const ages = new Set(raw.filter(c=>c.role !== '사람').map(c=>c.neutral));
  // If a genuinely generic absence also occurred in this field, provenance
  // is ambiguous. Retain that wording.
  for (const c of raw) if (c.role === '사람') ages.delete(c.original);
  if (!ages.size) return text;
  const original = sentences(text);
  const revised = original.map(s => {
    let result = s;
    for (const c of absenceClauses(s).reverse()) {
      if (c.role !== '사람' || !ages.has(c.original)) continue;
      const edit = omitClause(result,c.start,c.end);
      if (edit !== null) result = edit;
    }
    return result;
  });
  if (revised.every((s,i)=>s===original[i])) return text;
  return revised.filter(Boolean).join(' ') || null;
}

/** Reconcile only a broadened age-specific absence with its original field.
 * A clip's person count alone says nothing about presence at a given instant. */
export function reconcilePresence(observation:Observation|null, original?:Observation|null):Observation|null {
  if (!observation || !original || observation.peopleCount <= 0) return observation;
  let summary = repairField(observation.summary,original.summary);
  const moments = observation.moments.map(m=>{
    const raw = original.moments.find(candidate=>candidate.t===m.t);
    if (!raw) return m;
    const note = repairField(m.note,raw.note);
    if (note === m.note) return m;
    return {t:m.t, note:note ?? '이 시점의 동작은 분명하지 않아요.'};
  });
  if (summary === observation.summary && moments.every((m,i)=>m===observation.moments[i])) return observation;
  if (!summary && !moments.length && !observation.childStates.length && !observation.adultResponses.length) {
    summary = '구체적인 동작을 확인하기 어려워요.';
  }
  return {...observation,summary,moments};
}
