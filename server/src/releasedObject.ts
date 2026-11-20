import type { Observation } from './observation.ts';

export const throwClaim = /던[지져졌진질짐]|내던|집어던|투척|패스(?:를)?\s*(?:하|해|했)/;
export const impactClaim = /때[리려렸린]|내리[치쳐쳤]|물(?:건|체)을?\s*(?:쳐요|쳐서|치고|칩니다)/;

/** A writer can describe the start of a throw without recognizing the release. */
export function checkObjectMotion(draft: Observation): boolean {
  const text = [draft.summary, ...draft.moments.map(({ note }) => note)].join(' ');
  return draft.childStates.includes('THROWING_OR_HITTING') || throwClaim.test(text) ||
    (/(?:공[을이은과]|농구|배구|야구|블[록럭]|물[건체]|장난감)/.test(text) &&
      /손|팔|들고|집[어고]|들어|들었|쥐|날아|공중|주고받|튕[기겨]/.test(text));
}

type ReviewPrompt = { user: string; schema: { properties: Record<string, unknown>; required: string[] } };

export function objectMotionPrompt<T extends ReviewPrompt>(prompt: T, count: number) {
  const index = { type:'integer', minimum:0, maximum:count };
  return { ...prompt,
    user: prompt.user + `\nTrack the same visible object across these ${count} numbered images (1 through ${count}) in order.
motion: PROPELLED_THROUGH_AIR requires a hand initially holding the object, a sending arm/hand motion, then the same object visibly in midair and moving away from that hand. heldImage is the numbered image showing the object still in hand, freeImage is a later image actually showing it airborne. Never infer a pass from a sporting scene, arm pose, or the object changing hands across images. Merely placing, letting fall, bouncing on the ground, handing over, or an object disappearing are OTHER. If visibility or continuity is insufficient use UNCLEAR. For OTHER or UNCLEAR use 0 for both images. Do not infer a target or intent.`,
    schema: { ...prompt.schema, properties:{ ...prompt.schema.properties,
      motion:{ type:'string', enum:['UNCLEAR','OTHER','PROPELLED_THROUGH_AIR'] }, heldImage:index, freeImage:index,
    }, required:[...prompt.schema.required,'motion','heldImage','freeImage'] },
  };
}

/** Photos cannot establish a brief release across long gaps or from a frozen frame. */
export function releaseTime(text: string, frames: readonly number[], images: readonly string[]): number | null {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || value.motion !== 'PROPELLED_THROUGH_AIR' || !Number.isInteger(value.heldImage) ||
      !Number.isInteger(value.freeImage)) return null;
  const before = value.heldImage - 1, after = value.freeImage - 1;
  if (before < 0 || after <= before || after >= frames.length || images.length !== frames.length ||
      images[before] === images[after]) return null;
  const delta = frames[after]! - frames[before]!;
  return delta > 0 && delta <= 2 ? frames[after]! : null;
}
