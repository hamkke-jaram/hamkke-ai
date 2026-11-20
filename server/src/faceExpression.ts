import { toVisionOutput, type VisionProvider } from './provider.ts';

const expressions = ['SMILE', 'OPEN_MOUTH', 'NOT_SMILING', 'UNCLEAR'] as const;
const MAX_CHECK_MS = 10_000;
export type FaceExpression = typeof expressions[number];
export type FaceExpressions = { child: FaceExpression; adult: FaceExpression };

const face = { type: 'string', enum: expressions };
const prompt = {
  system: 'Look only at this exact silent photograph. Return the requested visible mouth shapes without interpreting emotion, intention, or sound.',
  user: `Report the child's face and the adult's face separately. First match each face to its own visible role. Use UNCLEAR separately for each absent or ambiguous role, if multiple faces could belong to that role, or if its mouth is too obscured to judge. Never transfer another person's expression.
SMILE: Both visible mouth corners turn upward, or a clearly curved mouth corner and visibly raised cheek give unmistakable evidence. An open mouth, visible teeth, or wide eyes alone do not establish a smile.
OPEN_MOUTH: A visibly open mouth without the required smile evidence. Do not call this laughing, shouting, crying, or speaking.
NOT_SMILING: The mouth is visible and closed or neutral, without the required smile evidence.
UNCLEAR: The visible shape cannot be determined.`,
  schema: {
    type: 'object', additionalProperties: false, required: ['child', 'adult'],
    properties: { child: face, adult: face },
  },
};

function decode(text: string): FaceExpressions | null {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2) return null;
  const fields = value as Record<string, unknown>;
  const child = expressions.find(expression => expression === fields.child);
  const adult = expressions.find(expression => expression === fields.adult);
  return child && adult ? { child, adult } : null;
}

/** Inspect one frame using the caller's deadline and a shorter optional-check budget. */
export async function verifyFacePhoto(provider: VisionProvider, image: string, signal: AbortSignal): Promise<FaceExpressions | null> {
  signal.throwIfAborted();
  const check = AbortSignal.any([signal, AbortSignal.timeout(MAX_CHECK_MS)]);
  let onAbort: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(check.reason);
    check.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const inference = Promise.resolve().then(() => {
      check.throwIfAborted();
      return provider.generate({ ...prompt, images: [image], signal: check });
    });
    const output = await Promise.race([inference, aborted]);
    check.throwIfAborted();
    return decode(toVisionOutput(output, provider.modelVersion).text);
  } catch {
    signal.throwIfAborted();
    return null;
  } finally {
    check.removeEventListener('abort', onAbort!);
  }
}
