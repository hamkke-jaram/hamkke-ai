import { toVisionOutput, type VisionProvider } from './provider.ts';

const positions = ['COVERING', 'TOUCHING', 'HANDS_RAISED', 'NO_COVER', 'UNCLEAR'] as const;
const placements = ['OVER_EAR', 'VISIBLE_GAP_OR_OTHER_LOCATION', 'UNCLEAR'] as const;
const MAX_CHECK_MS = 10_000;
export type EarPosition = typeof positions[number];

const prompt = {
  system: 'Inspect this exact single silent photograph for the child\'s hand and ear position. Report only what is visible in this photo.',
  user: `First locate a clearly identifiable child. Trace any relevant hand along the wrist and arm to verify it belongs to that child. If the child, hand ownership, or the relevant region is ambiguous, use UNCLEAR. Do not use another person's hand or infer a pose from a face, sound, or anything outside this single photo.
COVERING: The child's own palm or hand visibly lies flat across the ear or cups it against the side of the head. Its contact and position over the ear opening must both be clear. An ear hidden by hair or camera angle is insufficient evidence. A raised palm facing away from the head, spread fingers with a visible gap, and hands in front of the face do not establish covering. If overlap might be from perspective, use UNCLEAR.
TOUCHING: The child's own hand visibly touches the outer ear, with the ear opening visibly unobstructed.
HANDS_RAISED: One or both of the child's own hands are clearly held up without covering or touching an ear. There may be a visible gap, or the hand may rest at the cheek, temple, or hair rather than the ear.
NO_COVER: The child is clear and their visible hands are away from the ears and are not raised.
UNCLEAR: No unambiguous child or the relevant parts are obscured, so the pose cannot be verified. Do not guess contact or covering.`,
  schema: {
    type: 'object', additionalProperties: false, required: ['position'],
    properties: { position: { type: 'string', enum: positions } },
  },
};

const placement = {type:'string', enum:placements};
const contactPrompt = {
  system: 'Check spatial contact in this one photo. Examine each side of the child\'s head separately.',
  user: `For each side of the visible child's head, trace the child's own fingers and palm. OVER_EAR needs the hand directly against the side of the head, centered on the ear rather than above the head or in front of the cheek. Look specifically between the hand and the head: visible background or a palm suspended away from the head means VISIBLE_GAP_OR_OTHER_LOCATION. If you cannot trace the hand or see actual contact, use UNCLEAR. Do not infer anything from face or body expression. Use image directions for left and right.`,
  schema: {type:'object', additionalProperties:false, required:['left','right'],properties:{left:placement,right:placement}},
};

function decode(text: string): EarPosition | null {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 1) return null;
  const fields = value as Record<string, unknown>;
  return positions.find(position => position === fields.position) ?? null;
}

function confirmsCover(text: string): boolean {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== 'object' || Object.keys(value).length !== 2) return false;
  const fields = value as Record<string,unknown>;
  return placements.some(p=>p === fields.left) && placements.some(p=>p === fields.right) &&
    (fields.left === 'OVER_EAR' || fields.right === 'OVER_EAR');
}

/** Inspect a single sampled image under the request deadline and an optional-check budget. */
export async function verifyEarPhoto(provider: VisionProvider, image: string, signal: AbortSignal): Promise<EarPosition | null> {
  signal.throwIfAborted();
  const check = AbortSignal.any([signal, AbortSignal.timeout(MAX_CHECK_MS)]);
  let onAbort: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(check.reason);
    check.addEventListener('abort', onAbort, { once: true });
  });
  try {
    async function ask(specification: typeof prompt | typeof contactPrompt): Promise<string> {
      const inference = Promise.resolve().then(() => {
        check.throwIfAborted();
        return provider.generate({ ...specification, images:[image], signal:check });
      });
      const output = await Promise.race([inference, aborted]);
      check.throwIfAborted();
      return toVisionOutput(output,provider.modelVersion).text;
    }
    const position = decode(await ask(prompt));
    if (position === 'COVERING' && !confirmsCover(await ask(contactPrompt))) return 'UNCLEAR';
    return position;
  } catch {
    signal.throwIfAborted();
    return null;
  } finally {
    check.removeEventListener('abort', onAbort!);
  }
}
