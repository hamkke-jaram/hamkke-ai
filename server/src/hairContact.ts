import { toVisionOutput, type VisionProvider } from './provider.ts';

const roles = ['CHILD', 'ADULT', 'UNCLEAR'] as const;
const contacts = ['GRASP', 'TOUCH', 'NONE', 'UNCLEAR'] as const;
type Contact = { hand: typeof roles[number]; hair: typeof roles[number]; contact: typeof contacts[number] };
const CHECK_TIMEOUT_MS = 12_000;

// Physical hair contact needs its own verification. A face nearby or a hand at the
// edge of a photograph is insufficient to determine who touched whom.
export const hairClaim = /(?:머리카락|머리채|(?:아이|어른)(?:의)?\s*머리)[^.!?…,]{0,19}(?:잡|쥐|당[기겨겼]|뜯|움켜|뽑|닿|손(?:을)?\s*대)/;
const comparison = /않|못|듯|처럼|하려|려고|(?:뻗|가져가|갖다\s*대)\s*(?:려|려는)/;
const draftDirection = /(?:^|\s)(아이(?:가|는)|어른(?:이|은))\s+(?:(?:(?:왼손|오른손|한\s*손|두\s*손)으로|손을\s*뻗어)\s+)?(아이|어른)(?:의)?\s*(?:머리카락|머리채|머리)/;

const prompt = {
  system: 'Check only this one silent photo. Identify ownership from visible connected limbs, not from the viewer’s expectations. Return only the requested categories.',
  user: `Does a hand visibly touch or grasp someone's hair or scalp in this exact photo? Start by tracing the hand to its wrist and arm, then to the body. Identify the person whose hair is touched separately. An arm supporting a back, a hand near a head, and overlapping shapes without visible contact are not evidence of hair contact. A child held by an adult can be the one reaching; being held does not determine who owns the hand. GRASP requires visible fingers closing around hair. TOUCH requires a visible point of contact without a clear grasp. NONE means the hand is visibly away from hair. UNCLEAR means contact or the target cannot be seen. For hand and hair, report CHILD or ADULT only when that person's role is clear and their body is identifiable. Use UNCLEAR for obscured ownership or unclear role. Never infer force, intent, sound, or a family relationship.`,
  schema: {
    type:'object', additionalProperties:false, required:['hand','hair','contact'],
    properties:{ hand:{type:'string',enum:roles}, hair:{type:'string',enum:roles}, contact:{type:'string',enum:contacts} },
  },
};

function parseContact(text: string): Contact | null {
  try {
    const value = JSON.parse(text);
    if (value && roles.includes(value.hand) && roles.includes(value.hair) && contacts.includes(value.contact)) return value;
  } catch { /* Unusable output is insufficient evidence. */ }
  return null;
}

export function confirmedHairNote(note: string, witness: Contact | null): string | null {
  if (!witness || witness.contact === 'NONE' || witness.contact === 'UNCLEAR' || comparison.test(note)) return null;
  const direction = draftDirection.exec(note);
  const actor = direction?.[1]?.startsWith('아이') ? 'CHILD' : direction?.[1] ? 'ADULT' : null;
  const target = direction?.[2] === '아이' ? 'CHILD' : direction?.[2] === '어른' ? 'ADULT' : null;
  if (actor && target && actor !== target && actor === witness.hand && target === witness.hair) {
    const subject = actor === 'CHILD' ? '아이가 어른의' : '어른이 아이의';
    if (!/머리카락|머리채/.test(note)) return `${subject} 머리에 손을 대고 있어요.`;
    return witness.contact === 'GRASP' && /잡|쥐|당[기겨겼]|움켜/.test(note)
      ? `${subject} 머리카락을 잡고 있어요.`
      : `${subject} 머리카락에 손을 대고 있어요.`;
  }
  return '머리 쪽에 손이 닿아 있어요.';
}

export async function verifyHairPhoto(provider:VisionProvider, image:string, signal:AbortSignal):Promise<Contact|null> {
  signal.throwIfAborted();
  try {
    const check = AbortSignal.any([signal,AbortSignal.timeout(CHECK_TIMEOUT_MS)]);
    const output = toVisionOutput(await provider.generate({ ...prompt, images:[image], signal:check }), provider.modelVersion);
    return parseContact(output.text);
  } catch (error) {
    if (signal.aborted) throw error;
    return null;
  }
}
