import { toVisionOutput, ProviderTimeoutError } from './provider.ts';
import type { VisionProvider, VisionRequest } from './provider.ts';

const visible = ['UNCLEAR', 'TWO_OR_MORE_PEOPLE', 'ONE_PERSON', 'BODY_PARTS_ONLY', 'NO_PERSON'] as const;
const secondAction = ['UNCLEAR', 'PLAYING_THE_SAME_GAME', 'HELPING_WITH_AN_ORDINARY_TASK', 'ONLY_WATCHING_OR_NEARBY', 'NO_SECOND_VISIBLE_PERSON'] as const;
const focusAction = ['UNCLEAR', 'REACHING_FOR_OR_HOLDING_OBJECT', 'PLACING_OBJECT_ON_ANOTHER', 'HAND_OR_HEAD_GESTURE', 'WALKING_OR_RUNNING', 'OTHER'] as const;
const singleRole = ['UNCLEAR', 'CLEAR_CHILD', 'CLEAR_ADULT'] as const;
export type FrameWitness = {
  visible: typeof visible[number]; secondAction: typeof secondAction[number];
  focusAction: typeof focusAction[number]; singleRole: typeof singleRole[number];
  describedAlone?:boolean;
  noDescribedPartner?:boolean;
  secondSupportsPerson?:boolean;
  primaryChild?:boolean;
  primaryAdult?:boolean;
  marksSurface?:boolean;
  hasSmile?:boolean;
  hasGaze?:boolean;
  hasHandMotion?:boolean;
  describesObjectPlacement?:boolean;
  describesObjectHolding?:boolean;
};
const unknown: FrameWitness = {visible:'UNCLEAR', secondAction:'UNCLEAR', focusAction:'UNCLEAR', singleRole:'UNCLEAR'};
const category = (values:readonly string[]) => ({type:'string', enum:[...values]});
const placement = /\b(?:plac(?:es|ing)|puts|putting|sets|setting|lays|laying|lowers|lowering|stacks|stacking)\s+((?:(?:an?|the|one|another)\s+(?:[\w-]+\s+){0,3}[\w-]+)|(?:[a-z-]+\s+){0,2}[a-z-]+s)\s+(?:on top of|atop|onto (?:the )?top of)\s+((?:an?|the|one|another)\s+(?:[\w-]+\s+){0,3}[\w-]+)\b/i;
const holding = /\b(?:holds|holding|grasps|grasping|grips|gripping|carries|carrying|lifts|lifting)\s+((?:an?|the|one|another)\s+(?:[\w-]+\s+){0,3}[\w-]+)\b/i;
const uncertainPlacement = /\b(?:no|not|never|cannot|\w+n['’]t|unable|without|could|may|might|would|whether|unclear|unknown|maybe|perhaps|possibly|seem\w*|appear\w*|tr(?:y|ies|ying)|pretend\w*|plan\w*|intend\w*|rather than|about to|as (?:if|though)|looks? (?:as if|like|to be))\b/i;
const personOrBodyPart = /\b(?:bodies|body|hands?|fingers?|arms?|heads?|torso|legs?|feet|foot|faces?|persons?|people|child(?:ren)?|adults?|boys?|girls?|m[ae]n|wom[ae]n|shoulders?)\b/i;
const groundSurface = /\b(?:floors?|grounds?|grass|pavement|road|sidewalk|carpet|tiles?)\b/i;

function describesObjectPlacement(description:string):boolean {
  const match = placement.exec(description);
  return !!match && personOrBodyPart.test(description) && !uncertainPlacement.test(description) &&
    !personOrBodyPart.test(match[1]!) && !personOrBodyPart.test(match[2]!) && !groundSurface.test(match[2]!);
}

function describesObjectHolding(description:string):boolean {
  const match = holding.exec(description);
  return !!match && personOrBodyPart.test(description) && !uncertainPlacement.test(description) &&
    !personOrBodyPart.test(match[1]!);
}

const prompt = {
  system: 'Inspect ONLY the single photograph. A person outside the picture cannot contribute. Report visible facts only.',
  user: `FIRST, describe what you can locate in this single picture in English. actor1 and actor2 must each give an actual distinct person's screen position, visible body part and physical action in 4-14 words. Write NONE if no such person is visible. Do not count the same person twice. Do not count a drawing, a reflection, or a handheld object as a second person.
visible: Count distinct human bodies actually visible at the same instant. Two hands or two limbs are not two people. If only cropped limbs are visible and you cannot count bodies, choose BODY_PARTS_ONLY.
secondAction: Look for the second person's contribution. Choose PLAYING_THE_SAME_GAME only if both actively participate in the same game/sport. Helping a player reach a goal or facing a partner in a hand game can count. Ordinary work, marking paper, or standing alongside someone is not play. Use NO_SECOND_VISIBLE_PERSON for a single visible person.
focusAction: Describe the main person's physical action. PLACING_OBJECT_ON_ANOTHER requires an object in the person's hand being placed onto a second object; seeing a pile nearby is insufficient. Use UNCLEAR when the action is obscured.
singleRole: Only when there is one clearly visible person, report a visually unambiguous child/adult. If cropped, ambiguous, absent, or multiple, choose UNCLEAR.`,
  schema: {type:'object',properties:{actor1:{type:'string',maxLength:140},actor2:{type:'string',maxLength:140},visible:category(visible), secondAction:category(secondAction),
    focusAction:category(focusAction), singleRole:category(singleRole)},
    required:['actor1','actor2','visible','secondAction','focusAction','singleRole'], additionalProperties:false},
};

export function decodeFrameWitness(text:string): FrameWitness {
  try {
    const v = JSON.parse(text);
    if (!v || !visible.includes(v.visible) || !secondAction.includes(v.secondAction) ||
        !focusAction.includes(v.focusAction) || !singleRole.includes(v.singleRole) ||
        typeof v.actor1 !== 'string' || typeof v.actor2 !== 'string') return unknown;
    const absent = (s:string) => /^(?:none\b|no (?:one|other|second|person)|not visible|n\/?a\b)/i.test(s.trim());
    const located = (s:string) => !absent(s) && /\b(?:left|right|cent(?:er|re)|foreground|background|middle|front|back|edge|side|top|bottom|beside|near)\b/i.test(s) &&
      /\b(?:hands?|arms?|heads?|bod(?:y|ies)|torso|legs?|face|figures?|people|persons?|child(?:ren)?|adults?|players?|boys?|girls?|m[ae]n|wom[ae]n|shoulders?|seated|standing|sitting)\b/i.test(s);
    // Independently localized bodies positively establish co-presence even if
    // the subsequent coarse counter picked an incompatible category.
    // A pile, a person's location ("placed at left") and playing are not
    // evidence that a person is placing one object on top of another.
    const placing = /\b(?:plac(?:es|ing)|put(?:s|ting)?|stacks|stacking|sets|setting|lays|laying|lowers|lowering)\b/i.test(v.actor1);
    if (v.focusAction === 'PLACING_OBJECT_ON_ANOTHER' && (!placing || uncertainPlacement.test(v.actor1))) v.focusAction = 'UNCLEAR';
    if (v.focusAction === 'REACHING_FOR_OR_HOLDING_OBJECT' && !/reach|hold|grasp|grip|touch|carry|pick/i.test(v.actor1)) v.focusAction = 'UNCLEAR';
    const substantiveFirst = !absent(v.actor1) && !/^(?:unclear|unknown|cannot|unable|not sure)/i.test(v.actor1.trim()) &&
      v.actor1.trim().split(/\s+/).length >= 3;
    const describedAlone = substantiveFirst && absent(v.actor2) && v.secondAction === 'NO_SECOND_VISIBLE_PERSON';
    const details = {
      describedAlone,
      noDescribedPartner:substantiveFirst && absent(v.actor2) && v.secondAction !== 'PLAYING_THE_SAME_GAME',
      secondSupportsPerson:substantiveFirst && !absent(v.actor2) && v.actor1 !== v.actor2 &&
        /\b(?:support\w*|stead(?:y|ies|ying)|hold\w*|lift\w*|carr(?:y|ies|ying)|hug\w*|assist\w*)\b/i.test(v.actor2) &&
        /\b(?:child|toddler|baby|boy|girl|person|other|their|him|her|waist|arm|hand|back|shoulder|torso|body)\b/i.test(v.actor2),
      primaryChild:substantiveFirst && /\b(?:child|kid|boy|girl|toddler|baby)\b/i.test(v.actor1) && !/\b(?:woman|adult|man)\b/i.test(v.actor1),
      primaryAdult:substantiveFirst && /\b(?:adult|woman|man)\b/i.test(v.actor1) && !/\b(?:child|kid|boy|girl|baby)\b/i.test(v.actor1),
      marksSurface:substantiveFirst && /\b(?:draws?|drawing|writ(?:es?|ing)|colou?r(?:s|ing)?|stamp(?:s|ing)?|marks?|marking|sketch\w*|scribbl\w*|trac(?:es?|ing))\b/i.test(v.actor1),
      hasSmile:substantiveFirst && /\b(?:smil\w*|laugh\w*|grin\w*)\b/i.test(v.actor1),
      hasGaze:substantiveFirst && /\b(?:look\w*|watch\w*|gaz\w*|turn\w*|tilt\w*|nod\w*)\b/i.test(v.actor1),
      hasHandMotion:substantiveFirst && /\b(?:hands?|arms?|fingers?)\b/i.test(v.actor1) && /\b(?:lift\w*|rais\w*|reach\w*|wav\w*|mov\w*|point\w*)\b/i.test(v.actor1),
      describesObjectPlacement:describedAlone && v.focusAction === 'PLACING_OBJECT_ON_ANOTHER' && describesObjectPlacement(v.actor1),
      describesObjectHolding:describedAlone && describesObjectHolding(v.actor1),
    };
    const unclearCount:FrameWitness = { ...unknown, ...details, focusAction:substantiveFirst ? v.focusAction : 'UNCLEAR' };
    if (located(v.actor1) && located(v.actor2) && v.actor1.trim() !== v.actor2.trim()) v.visible = 'TWO_OR_MORE_PEOPLE';
    if (v.visible === 'ONE_PERSON' && (!located(v.actor1) || !absent(v.actor2))) return unclearCount;
    if (v.visible === 'TWO_OR_MORE_PEOPLE' && (!located(v.actor1) || !located(v.actor2) || v.actor1 === v.actor2)) return unclearCount;
    if (v.visible === 'NO_PERSON' && (!absent(v.actor1) || !absent(v.actor2) || !['UNCLEAR','OTHER'].includes(v.focusAction))) return unclearCount;
    return {visible:v.visible, secondAction:v.secondAction, focusAction:v.focusAction, singleRole:v.singleRole, ...details};
  } catch { /* The unverified still cannot establish who took part. */ }
  return unknown;
}

export function witnessImages(photos:readonly string[]):string[] {
  if (!photos.length) return [];
  return [...new Set([photos[0]!, photos[Math.floor(photos.length / 2)]!, photos[photos.length-1]!])];
}

export async function inspectFrames(provider:VisionProvider, request:VisionRequest, chosen:readonly string[]):Promise<FrameWitness[]> {
  const frames:FrameWitness[] = [];
  for (const image of chosen) {
    request.signal.throwIfAborted();
    try {
      const output = toVisionOutput(await provider.generate({...prompt, images:[image], signal:request.signal}),provider.modelVersion);
      frames.push(decodeFrameWitness(output.text));
    } catch (error) {
      if (request.signal.aborted || error instanceof ProviderTimeoutError) throw error;
      frames.push(unknown);
    }
  }
  return frames;
}
