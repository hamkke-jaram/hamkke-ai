// Review an existing observation against the same images. The writer always sees its
// original instructions and never receives this review or the evaluator's labels.
import { normaliseObservation, parseModelJson, keepLinesIfUnchanged, withoutLines, MAX_SUMMARY_SENTENCES, MAX_SUMMARY_LENGTH, MAX_NOTE_LENGTH, MAX_MOMENTS, limitText } from './observation.ts';
import type { Observation } from './observation.ts';
import { toVisionOutput, ProviderTimeoutError } from './provider.ts';
import type { VisionProvider, VisionRequest } from './provider.ts';
import { inspectFrames, witnessImages } from './frameWitness.ts';
import type { FrameWitness } from './frameWitness.ts';
import { independentPeople } from './personBoxes.ts';
import { reconcilePresence } from './presence.ts';
import { throwClaim, impactClaim, checkObjectMotion, objectMotionPrompt, releaseTime } from './releasedObject.ts';
import { confirmedHairNote, hairClaim, verifyHairPhoto } from './hairContact.ts';

const appearances = ['UNRESOLVED', 'CLEAR_CHILDREN_ONLY', 'CLEAR_ADULTS_ONLY', 'MIXED_AGES', 'PARTS_ONLY'] as const;
const participants = ['ONE_VISIBLE_PARTICIPANT', 'MULTIPLE_VISIBLE_PARTICIPANTS', 'UNRESOLVED'] as const;
const activities = ['SHARED_PLAY', 'SOLO_PLAY', 'OTHER_JOINT_ACTION', 'NO_CLEAR_PLAY', 'UNRESOLVED'] as const;
const participation = ['ONE_PERSON_DOES_THE_ACTION', 'TWO_PEOPLE_PLAY_THE_SAME_GAME', 'ANOTHER_PERSON_ONLY_WATCHES', 'OTHER_JOINT_TASK', 'CANNOT_TELL'] as const;
type Review = { appearance: typeof appearances[number]; participants: typeof participants[number]; activity: typeof activities[number]; participation?: typeof participation[number] };
const unknown: Review = { appearance:'UNRESOLVED', participants:'UNRESOLVED', activity:'UNRESOLVED' };
const enumeration = (values: readonly string[]) => ({type:'string', enum:[...values]});

const reviewPrompt = {
  system: 'Look at the silent images independently. Return only the requested categories. Do not estimate anyone\'s numerical age.',
  user: `Inspect the full image series. If a head, torso, or a standing, seated or walking figure is shown anywhere, this is not a hands-only shot. appearance: choose UNRESOLVED unless a role is visually clear. CLEAR_CHILDREN_ONLY and CLEAR_ADULTS_ONLY require positive visual evidence for all visible people. A turned or blurred face alone establishes neither. Choose PARTS_ONLY only for a close-up of isolated body parts throughout. Do not infer age from the activity.
participants: count distinct visible people separately from recognizing their ages. A cropped pair of hands may belong to one person. A camera operator outside the image is not another participant.
activity: Decide from the actual actions, independently of age. SHARED_PLAY includes two people visibly engaged in the same game/sport, taking turns or cooperating with play equipment. They need not touch one another. SOLO_PLAY needs an identifiable independent game or toy action. Two people cooperating on an ordinary task are OTHER_JOINT_ACTION. Mere proximity, observing someone, ordinary walking, crouching, or simply reaching toward the same object are not evidence of shared play. Use UNRESOLVED for insufficient visual evidence.`,
  schema: {type:'object', properties:{appearance:enumeration(appearances), participants:enumeration(participants), activity:enumeration(activities)},
    required:['appearance','participants','activity'], additionalProperties:false},
};

// A person beside or behind a child is not evidence that both people are playing.
// Ask for the second person's contribution only when there is a joint claim to check.
const partnerPrompt = {
  ...reviewPrompt,
  user: reviewPrompt.user + '\nparticipation: Inspect the hands, bodies and actions in the images. Identify who actually performs the activity. A person working alone on an object is ONE_PERSON_DOES_THE_ACTION even if the camera moves. A spectator is ANOTHER_PERSON_ONLY_WATCHES. Two active players may help, take turns or play the same sport at a distance. Choose TWO_PEOPLE_PLAY_THE_SAME_GAME only if you can see an action by each player in that game. Choose CANNOT_TELL if the second contribution is hidden or unclear.',
  schema: { ...reviewPrompt.schema, properties: { ...reviewPrompt.schema.properties, participation:enumeration(participation) },
    required: [...reviewPrompt.schema.required, 'participation'] },
};

function decodeReview(text: string): Review {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return unknown; }
  if (!value || typeof value !== 'object') return unknown;
  const r = value as Record<string,unknown>;
  if (!appearances.some(x=>x===r.appearance) || !participants.some(x=>x===r.participants) || !activities.some(x=>x===r.activity)) return unknown;
  return { appearance:r.appearance, participants:r.participants, activity:r.activity,
    participation:participation.find(value => value === r.participation) } as Review;
}

const speech = /비명|고함|함성|울음소리|목소리|큰\s*소리|소리(?:를|가)?\s*(?:지르|질러|질렀|지른|지름|내[요고는며]|내어|냈|들[리려렸]|나[요고는며])|외[치쳐쳤]|대화|이야기(?:를\s*)?(?:나누|나눠|하|해)|말을\s*(?:걸|건|나누|나눠|해|하|주고받)|말(?:해[요주줘]|하[고며면서려는]|했)|대답|질문|칭찬(?:해|하)|설명(?:해|하)/;
const together = /(?:함께|같이|서로|(?:아이|어른|사람)(?:와|과|이랑|랑)|두\s*(?:명|사람))[^.!?]{0,18}(?:놀(?:아요|고|며)|놀이(?:를|에|하))/;
const play = /놀(?:아요|아줘|아주|고\s*(?:있|놀)|며)|놀이(?:를\s*(?:해|하)|하고|해요)/;
const ageWords = /(?<![가-힣])(아이|어른)(들)?(에게|한테|이랑|랑|은|는|이|가|을|를|와|과|의|도|만|에|로|으로)?(?![가-힣])/g;
const afterPerson: Record<string,string> = { 가:'이', 는:'은', 를:'을', 와:'과', 랑:'이랑', 로:'으로' };
const fullFigureAction = /걷|걸어|걸음|뛰|달리|달려|앉|서\s*(?:있|서|있는|서서)|일어서|선\s*채|상체|몸통|몸을\s*(?:돌|숙|굽|기울)|고개|얼굴|머리|무릎|다리(?:가|를|로)|타고\s*(?:가|있)|걸터/;
const handFocus = /(?:손|팔)(?:만|이|은|을|에|로|으로|가락|목|바닥|등)|(?:아이|어른|사람)(?:의)?\s*(?:왼쪽\s*|오른쪽\s*|양|왼|오른)?(?:손|팔)/;
const namedGroup = /(?:두|세|여러|다른)\s*(?:명|사람|아이|어른)|(?:아이|어른|사람)들/;
const pairedActors = /(?:아이|어른|사람)(?:와|과|랑|이랑)\s*(?:아이|어른|사람)/;
const isolated = /혼자|홀로|단독|(?:아이|어른|한\s*사람)만\s*(?:있|보)/;
const genericPosture = /^(?:(?:아이(?:가|는)|어른(?:이|은)|(?:한\s*)?사람(?:이|은))\s+)?(?:서|앉아)\s+있(?:어요|네요)[.!?…]?$/;
const comforting = /달래|진정시켜|진정시키|위로(?:해|하)/;
const coversEars = /귀(?:를)?\s*(?:손으로\s*)?(?:가리|가려|막|덮)/;
const earPosition = String.raw`귀(?:에|\s*(?:옆|쪽|뒤|근처)에)`;
const handAtEar = new RegExp(String.raw`(?:손(?:을)?\s*${earPosition}|${earPosition}\s*(?:(?:두|양)\s*)?손(?:을)?)\s*(?:올|대|가져)`);
const handAtHead = /손(?:을)?\s*(?:자기\s*)?머리(?:에|로|\s*(?:옆|쪽)(?:에|으로))\s*(?:올|얹|대|가져)|머리(?:에|\s*(?:옆|쪽)(?:에|으로))\s*(?:(?:두|양)\s*)?손(?:을)?\s*(?:올|얹|대|가져)/;
const raisedHands = /손(?:을)?\s*(?:위로\s*)?(?:들(?:어|고|며)|올[리려])/;
const towardsAdult = /어른(?:에게|한테|\s*쪽으로|\s*곁으로)[^.!?…]{0,25}(?:다가가|걸어가|뻗)/;
const childCrying = /(?:울(?:어요|고|며|면서|었|기\s*시작)|흐느[끼껴]|울먹)/;
const otherPersonHand = /(아이|어른)(?:의)?\s*(?:(?:왼|오른|양(?:쪽)?|한쪽)\s*)?손(?:목|가락)?(?:을|를)\s*(?:붙?잡|움켜쥐|쥐|당[기겨겼])/;
const namedHandoff = /(?:아이|어른)(?:에게|한테)[^.!?…]{0,23}(?:건네(?:주|줘|요|고|며|는|자)|건넨)/;
const toyHandling = /(?:장난감|블록|인형|공을)[^.!?…]{0,16}(?:만지|만져|쌓|올리|올려|옮기|옮겨|굴리|굴려|밀어|내려놓)/;
const toyCompanion = /^((?:아이(?:가|는)|어른(?:이|은))\s+)(?:아이|어른)(?:와|과|이랑|랑)\s*(?:함께|같이)\s+/;
const pairedToyActors = /^(?:아이|어른)(?:와|과|이랑|랑)\s*(?:아이|어른)(?:가|이|는|은)\s+/;
const earCoverNote = '아이가 손으로 귀를 가려요.';
const EAR_GESTURE_RADIUS_SECONDS = 2.1;

function unconfirmedHandContact(text: string, witnesses: readonly FrameWitness[]): boolean {
  const hand = otherPersonHand.exec(text);
  if (!hand) return false;
  const actor = /(?:^|\s)(아이(?:가|는)|어른(?:이|은))\s/.exec(text)?.[1];
  if (actor?.startsWith('아이') && hand[1] === '어른') return !witnesses.some(w => w.childGraspsAdultHand);
  if (actor?.startsWith('어른') && hand[1] === '아이') return !witnesses.some(w => w.adultGraspsChildHand);
  return true;
}

function earGesture(text: string): boolean {
  return coversEars.test(text) || handAtEar.test(text);
}

function ambiguousHeadGesture(text: string): boolean {
  return handAtHead.test(text) || handAtEar.test(text);
}

function describesObjectHandling(text:string, placementOnly = false):boolean {
  return text.split(/[,.!?…]/).some(clause => {
    if (/않|못|듯|처럼|려고/.test(clause)) return false;
    return [...clause.matchAll(/([가-힣]+)[을를]\s+(들(?:고|어요|어)|쌓(?:아|고|으)|올(?:려|리)|(?:내려)?놓(?:아|고|으)|얹|옮(?:겨|기)|집(?:어|고|어요))/g)]
      .some(([, object, action]) => !/^(?:신체|몸|상체|손|손가락|팔|머리|고개|시선|다리|발|얼굴|어깨|아이|어른|사람)$/.test(object!) &&
        (!placementOnly || /^(?:쌓|올|(?:내려)?놓|얹)/.test(action!)));
  });
}

function hasJointClaim(obs: Observation): boolean {
  return obs.childStates.includes('PLAYING_TOGETHER') || obs.adultResponses.includes('JOINING_PLAY') ||
    [obs.summary, ...obs.moments.map(m => m.note)].some(s => s && (together.test(s) ||
      s.split(/(?<=[.!?…])\s+/).some(part=>toyHandling.test(part) && (toyCompanion.test(part) || pairedToyActors.test(part)))));
}

function checkablePartnerClaim(obs: Observation, child:boolean, adult:boolean): boolean {
  return hasJointClaim(obs) || obs.peopleCount >= 2 || (child && adult);
}

// Closing a connective in isolation can change its meaning ("하려고" is an
// intention). Close only visible predicates with known, grammatical endings.
const visualEndings: ReadonlyArray<readonly [RegExp,string]> = [
  [/바라보(?:면서|며)$/, '바라봐요.'], [/쳐다보(?:면서|며)$/, '쳐다봐요.'],
  [/내다보(?:면서|며)$/, '내다봐요.'], [/보(?:면서|며)$/, '봐요.'],
  [/움직이(?:면서|며)$/, '움직여요.'], [/돌리(?:면서|며)$/, '돌려요.'],
  [/올리(?:면서|며)$/, '올려요.'], [/내리(?:면서|며)$/, '내려요.'],
  [/가리키(?:면서|며)$/, '가리켜요.'], [/흔들(?:면서|며)$/, '흔들어요.'],
  [/들(?:면서|며)$/, '들어요.'], [/만지(?:면서|며)$/, '만져요.'],
  [/웃으(?:면서|며)$/, '웃어요.'], [/잡으(?:면서|며)$/, '잡아요.'],
  [/걸으(?:면서|며)$/, '걸어요.'], [/뛰(?:면서|며)$/, '뛰어요.'],
  [/걸어가(?:면서|며)$/, '걸어가요.'], [/다가가(?:면서|며)$/, '다가가요.'],
  [/숙이(?:면서|며)$/, '숙여요.'], [/그리(?:면서|며)$/, '그려요.'],
  [/놀(?:면서|며)$/, '놀아요.'], [/놀이를?\s*하(?:면서|며)$/, '놀이를 해요.'],
];

function closeVisibleAction(clause: string): string | null {
  if (!/\s/.test(clause)) return null;
  if (/고$/.test(clause) && !/(?:라고|려고|자고|다고|냐고|말하고)$/.test(clause)) return clause + ' 있어요.';
  for (const [ending, replacement] of visualEndings) {
    if (ending.test(clause)) return clause.replace(ending, replacement);
  }
  return null;
}

function keepVisibleClauses(sentence: string, reject: (text:string) => boolean): string | null {
  if (!reject(sentence)) return sentence;
  const kept: string[] = [];
  for (const part of sentence.split(/,\s*/)) {
    const clause = part.trim();
    if (!reject(clause)) {
      const complete = /요[.!?…]?$/.test(clause) ? clause : closeVisibleAction(clause);
      if (complete) kept.push(complete);
      continue;
    }
    const boundaries = [...clause.matchAll(/(?<=(?:면서|으며|며|고|서))\s+/g)];
    // Take the longest physical prefix so "holding A and looking at B while
    // talking" retains both the holding and the gaze.
    for (const b of [...boundaries].reverse()) {
      const left = clause.slice(0, b.index).trim();
      const complete = !reject(left) && closeVisibleAction(left);
      if (complete) { kept.push(complete); break; }
    }
    for (const b of boundaries) {
      const prefix = clause.slice(0, b.index);
      const suffix = clause.slice(b.index + b[0].length).trim();
      if (!reject(prefix) || reject(suffix) || !/요[.!?…]?$/.test(suffix) ||
          /^(?:있어요|있었어요|싶어요|싶었어요|계세요|계셨어요|해요|했어요)[.!?…]?$/.test(suffix)) continue;
      // The subject of a connected verb also governs its subsequent verb,
      // unless that verb has its own explicit subject.
      const actor = /^(아이(?:가|는)|어른(?:이|은)|사람(?:이|은))\s/.exec(prefix)?.[1];
      const ownSubject = /(?:^|\s)(?:아이(?:가|는)|어른(?:이|은)|사람(?:이|은)|[가-힣]+(?:이|가))\s/.test(suffix);
      if (/\s/.test(suffix) || actor) kept.push(actor && !ownSubject ? actor+' '+suffix : suffix);
      break;
    }
  }
  return kept.length ? kept.join(' ') : null;
}

function neutralAge(text: string): string {
  return text.replace(ageWords, (_whole, _label, plural?: string, particle?: string) =>
    '사람' + (plural ?? '') + (afterPerson[particle ?? ''] ?? particle ?? ''));
}

/** Keep separate visible movement while checking a particular hand-to-hair claim. */
async function reconcileHairContact(observation:Observation, provider:VisionProvider,
  images:readonly string[], times:readonly number[], signal:AbortSignal):Promise<Observation> {
  const related = observation.moments.filter(({note}) => hairClaim.test(note));
  if (!hairClaim.test(observation.summary ?? '') && !related.length) return observation;

  const verified = new Map<number,string>();
  // Review only claimed event frames. Other moments never inherit a contact or role.
  for (const {t,note} of related.slice(0,2)) {
    const image = images[times.indexOf(t)];
    if (!image) continue;
    const witness = await verifyHairPhoto(provider,image,signal);
    const contact = confirmedHairNote(note,witness);
    if (contact) verified.set(t,contact);
  }

  const stripsContact = (text:string):string => text.split(/(?<=[.!?…])\s+|(?<=요[.!?])(?=[가-힣])/)
    .map(sentence => keepVisibleClauses(sentence,clause=>hairClaim.test(clause)))
    .filter(Boolean).join(' ');
  const moments = observation.moments.flatMap(({t,note}) => {
    const remaining = stripsContact(note);
    const checked = [verified.get(t),remaining].filter(Boolean).join(' ');
    return checked ? [{t,note:limitText(checked,Number.POSITIVE_INFINITY,MAX_NOTE_LENGTH)}] : [];
  });
  const previousSummary = observation.summary ?? '';
  let summary = stripsContact(previousSummary);
  if (hairClaim.test(previousSummary)) {
    // Role assignments belong to their checked instant, not the whole video.
    const combined = [...new Set(verified.values())];
    const contact = combined.length === 1 ? combined[0] : combined.length > 1 ? '머리 쪽에 손이 닿아 있어요.' : '';
    summary = limitText([summary,contact].filter(Boolean).join(' '),MAX_SUMMARY_SENTENCES,MAX_SUMMARY_LENGTH);
  }
  return { ...observation, moments,
    summary:summary || (moments.length ? null : '확인한 장면에서 구체적인 동작을 구별하기 어려워요.') };
}

export function applyReview(obs: Observation, review: Review, witnesses:readonly FrameWitness[]=[], independent:readonly number[]|null=null, releasedAt:number|null=null,
  witnessTimes:readonly number[]=[]): Observation | null {
  const sceneText = [obs.summary, ...obs.moments.map(m => m.note)].filter(Boolean).join(' ');
  // A full-body activity in the draft contradicts a claimed hands-only crop. In that
  // situation a second look is not enough to erase the original actor.
  const physicalText = sceneText.replace(/말(?:을)?\s*걸/g, '');
  const childOnly = review.appearance === 'CLEAR_CHILDREN_ONLY';
  const adultOnly = review.appearance === 'CLEAR_ADULTS_ONLY';
  const childInDraft = /(?:^|\s)아이/.test(sceneText);
  const adultInDraft = /(?:^|\s)어른/.test(sceneText);
  const multipleInDraft = obs.peopleCount >= 2;
  const visibleActors = physicalText.split(/[.!?…]+/).map(s => keepVisibleClauses(s, text => speech.test(text))).filter(Boolean).join(' ');
  const separateActors = namedGroup.test(visibleActors) || pairedActors.test(visibleActors) ||
    (/아이[는가]/.test(visibleActors) && /어른[은이]/.test(visibleActors)) || /주고\s*받/.test(visibleActors) ||
    (/아이의\s*[^.!?]{0,5}(?:손|팔)/.test(visibleActors) && /어른의\s*[^.!?]{0,5}(?:손|팔)/.test(visibleActors));
  const checked = witnesses.length > 0;
  const boxes = independent?.length === witnesses.length && independent.every(n => Number.isInteger(n) && n >= 0) ? independent : [];
  const groupDetected = boxes.some(n => n >= 2);
  const oneDetected = !groupDetected && boxes.some(n => n === 1);
  const onlyLimbs = checked && witnesses.every(f => f.visible === 'BODY_PARTS_ONLY');
  const supportPair = witnesses.filter(f=>f.secondSupportsPerson).length >= 2;
  // Locate one person and no second actor in at least two independent stills.
  // If the frame classifier contradicts its own descriptions, use those
  // descriptions only when the different CPU detector also found a person.
  const singlePhotos = witnesses.filter(f => (f.visible === 'ONE_PERSON' && f.secondAction === 'NO_SECOND_VISIBLE_PERSON') ||
    (oneDetected && f.describedAlone));
  const oneRole = new Set(singlePhotos.map(f => f.singleRole).filter(r => r !== 'UNCLEAR'));
  const witnessedSolo = !groupDetected && !supportPair && (oneDetected || !boxes.length) && checked &&
    singlePhotos.length >= Math.min(2,witnesses.length) && oneRole.size <= 1 &&
    witnesses.every(f => singlePhotos.includes(f) || f.visible === 'NO_PERSON');
  const noPeople = !oneDetected && !groupDetected && !supportPair && checked && !separateActors && !fullFigureAction.test(physicalText) && !handFocus.test(physicalText) &&
    witnesses.every(f => f.visible === 'NO_PERSON' && f.secondAction === 'NO_SECOND_VISIBLE_PERSON');
  const soloRole = witnessedSolo && singlePhotos.every(f => f.singleRole === singlePhotos[0]!.singleRole)
    ? singlePhotos[0]!.singleRole : 'UNCLEAR';
  const checkedActions = witnesses.filter((f,i) => singlePhotos.includes(f) || boxes[i] === 1);
  const placing = checkedActions.filter(f => f.focusAction === 'PLACING_OBJECT_ON_ANOTHER').length;
  const holding = checkedActions.filter(f => f.focusAction === 'REACHING_FOR_OR_HOLDING_OBJECT').length;
  const dropSecondActor = witnessedSolo && (multipleInDraft || hasJointClaim(obs) || (childInDraft && adultInDraft));
  const groupPhotos = witnesses.filter(f => f.visible === 'TWO_OR_MORE_PEOPLE');
  // Intermittent visibility can leave just one located actor in a whole clip.
  // It can justify abstaining on an invented partner, but not setting the
  // participant count to one. Keep evidence of reciprocation across a cut.
  const reciprocal = /주고\s*받|번갈아|교대/.test(visibleActors);
  const repeatedVisualPlay = groupPhotos.filter(f => f.secondAction === 'PLAYING_THE_SAME_GAME').length >= 2;
  const solelyDescribed = witnesses.filter(f=>f.noDescribedPartner || f.describedAlone);
  const partnerAbsentFromDescriptions = groupPhotos.length === 0 && solelyDescribed.length >= 2 &&
    witnesses.every(f => f.noDescribedPartner || f.describedAlone || f.visible === 'UNCLEAR' || f.visible === 'NO_PERSON');
  const unverifiedPartner = !groupDetected && !supportPair && checkablePartnerClaim(obs,childInDraft,adultInDraft) &&
    ((oneDetected && !(repeatedVisualPlay && reciprocal)) || (singlePhotos.length > 0 && groupPhotos.length === 0 && !reciprocal) ||
     partnerAbsentFromDescriptions);
  const hideSecondActor = dropSecondActor || unverifiedPartner;
  const playPhoto = groupPhotos.some(f => f.secondAction === 'PLAYING_THE_SAME_GAME');
  const ordinaryPhotos = groupPhotos.filter(f => f.secondAction === 'HELPING_WITH_AN_ORDINARY_TASK' || f.secondAction === 'ONLY_WATCHING_OR_NEARBY');
  const taskInDraft = /글(?:씨|자|을)|칠판|그림을\s*그|색칠|청소|닦[아고는]|요리|정리|서류|숙제/.test(visibleActors);
  const checkedTask = groupDetected && taskInDraft && !reciprocal && (ordinaryPhotos.length > 0 ||
    review.activity === 'OTHER_JOINT_ACTION' || review.participation === 'OTHER_JOINT_TASK');
  const nonplay = !playPhoto && (checkedTask || (ordinaryPhotos.length >= Math.min(2,Math.max(1,witnesses.length)) &&
    (ordinaryPhotos.length === groupPhotos.length || review.activity !== 'SHARED_PLAY')));
  const partial = !groupDetected && !supportPair && (onlyLimbs || (review.appearance === 'PARTS_ONLY' && review.participants !== 'MULTIPLE_VISIBLE_PARTICIPANTS')) &&
    handFocus.test(physicalText) && !fullFigureAction.test(physicalText) && !(multipleInDraft && separateActors);
  const single = !groupDetected && !supportPair && !multipleInDraft && review.participants !== 'MULTIPLE_VISIBLE_PARTICIPANTS' &&
    (review.participants === 'ONE_VISIBLE_PARTICIPANT' || review.activity === 'SOLO_PLAY' ||
     (review.activity === 'NO_CLEAR_PLAY' && isolated.test(physicalText)));
  // Counting two people does not describe a second player. Where the draft gives
  // a concrete action for two actors, retain the earlier protection for real play.
  const rolePair = /아이(?:가|는|들이|들은)\s/.test(visibleActors) && /어른(?:이|은|들이|들은)\s/.test(visibleActors);
  const jointAction = /주고\s*받|번갈아|교대|던지|던져|차(?:며|고|요)|차는|받아|잡아|들어\s*올|내밀|손을\s*(?:맞|잡)|치며|움직|굴리|뛰|굴려|올리|내리/;
  const draftSupportsPair = !isolated.test(visibleActors) && (rolePair ||
    ((namedGroup.test(visibleActors) || pairedActors.test(visibleActors)) && jointAction.test(visibleActors)) ||
    /주고\s*받|번갈아|교대/.test(visibleActors));
  const visualPair = review.participation === 'TWO_PEOPLE_PLAY_THE_SAME_GAME' ||
    (review.activity === 'SHARED_PLAY' && review.participants === 'MULTIPLE_VISIBLE_PARTICIPANTS' &&
     (!review.participation || review.participation === 'CANNOT_TELL'));
  const soloSeries = review.activity === 'SOLO_PLAY' || review.participation === 'ONE_PERSON_DOES_THE_ACTION' ||
    review.participation === 'ANOTHER_PERSON_ONLY_WATCHES';
  // A single coarse play label cannot override a check of the entire series.
  // Keep real exchanges and repeated photographs with two concrete contributions.
  const corroboratedPlay = reciprocal || groupPhotos.filter(f => f.concretePlayPair && f.secondAction === 'PLAYING_THE_SAME_GAME').length >= 2;
  const jointGame = obs.peopleCount > 0 && !partial && !hideSecondActor && !noPeople && !nonplay &&
    (soloSeries ? corroboratedPlay : playPhoto || ((!single || groupDetected) && (draftSupportsPair || visualPair)));
  const soloEvidence = hideSecondActor;
  const soloGame = !partial && (!multipleInDraft || isolated.test(physicalText) || review.activity !== 'SHARED_PLAY');
  const incompatibleAges = (childOnly || adultOnly) && !supportPair && !((multipleInDraft || groupDetected) && childInDraft && adultInDraft);
  const witnessedComfort = witnesses.some(f=>f.adultComfortContact);
  const earTimes = witnessTimes.filter((_time,i)=>witnesses[i]?.childCoversOwnEars);
  const earContextTimes = [...earTimes, ...obs.moments.filter(m=>earGesture(m.note)).map(m=>m.t)];

  function unsupported(text: string): boolean {
    // Even a corroborated release says nothing about a target, intention or sound.
    // Only the time-bounded observation below may describe it as a throw.
    const unconfirmedCatch = releasedAt !== null && !jointGame
      && /받아\s*(?:주|줘|줬|준|내|낸|냈)|공을\s*(?:주고\s*받|받아요)/.test(text);
    return speech.test(text) || throwClaim.test(text) || unconfirmedCatch || comforting.test(text) || (!jointGame && together.test(text))
      || (!soloGame && !jointGame && play.test(text));
  }

  function describeActor(sentence:string):string|null {
    const child = /(?:^|\s)아이/.test(sentence);
    const adult = /(?:^|\s)어른/.test(sentence);
    if (hideSecondActor) {
      if ((child && adult) || namedGroup.test(sentence) || pairedActors.test(sentence)) return null;
      // Rejecting the social claim does not refute an independent physical
      // predicate. Keep the action and only revise the identity when necessary.
      const handCloseup = partial || (onlyLimbs && !fullFigureAction.test(sentence));
      if (handCloseup) return neutralAge(sentence.replace(/(?:아이|어른)(?:들)?(?:의)?\s+((?:양쪽\s*|왼쪽\s*|오른쪽\s*|양|왼|오른)?(?:손|팔))/g,'$1'));
      const agreedMark = /그리|그려|찍|표시|자국|칠하|색칠|쓰고|적고/.test(sentence) && witnesses.some(f=>f.marksSurface);
      const agreedBody = (/웃|미소/.test(sentence) && witnesses.some(f=>f.hasSmile)) ||
        (/고개|시선|바라|쳐다/.test(sentence) && witnesses.some(f=>f.hasGaze)) ||
        (/손|팔/.test(sentence) && witnesses.some(f=>f.hasHandMotion));
      if (child && !witnesses.some(f=>f.primaryAdult) && soloRole !== 'CLEAR_ADULT' &&
          (soloRole === 'CLEAR_CHILD' || witnesses.some(f=>f.primaryChild) || agreedBody || (!agreedMark && fullFigureAction.test(sentence)))) return sentence;
      if (adult && (soloRole === 'CLEAR_ADULT' || (witnesses.some(f=>f.primaryAdult) && !witnesses.some(f=>f.primaryChild)))) return sentence;
      return neutralAge(sentence);
    }
    if (partial) {
      if (child && adult) return null;
      // Do not turn "the child is not visible" into "no person is visible".
      if (/아이(?:는|가)?\s*(?:없|보이지\s*않|안\s*보)/.test(sentence)) return null;
      return neutralAge(sentence.replace(/(?:아이|어른)(?:들)?(?:의)?\s+((?:양쪽\s*|왼쪽\s*|오른쪽\s*|양|왼|오른)?(?:손|팔))/g,'$1'));
    }
    if (single && obs.peopleCount === 1 && childInDraft && adultInDraft && ((adult && childOnly) || (child && adultOnly))) {
      if (adult && child) return null;
      return neutralAge(sentence);
    }
    return sentence;
  }

  function cleanSentence(original:string, at:readonly FrameWitness[], earCrying:boolean, nearbyReachUnverified:boolean):string|null {
    const unconfirmedHandoff = soloSeries && !corroboratedPlay && namedHandoff.test(original);
    const sentence = !jointGame && toyHandling.test(original) ? original.replace(toyCompanion,'$1') : original;
    const retained = keepVisibleClauses(sentence, text => unsupported(text) ||
      unconfirmedHandContact(text, at) || (earCrying && childCrying.test(text)) ||
      (nearbyReachUnverified && towardsAdult.test(text)) ||
      (unconfirmedHandoff && (namedHandoff.test(text) || /도와|돕/.test(text))) ||
      (!jointGame && pairedToyActors.test(text) && toyHandling.test(text)) ||
      (throwClaim.test(original) && /조준|겨냥|일부러|맞히려고|맞추려고|해치려고|겁(?:을)?\s*주려고/.test(text)) ||
      (hideSecondActor && /함께|서로|같이|옆에서\s*지켜|주고\s*받|건네(?:주|줘|요|고|며|는|자|받)|건넨|보여\s*(?:주|줘)|(?:아이|어른|사람)(?:와|과|이랑|랑)\s*(?:아이|어른|사람)|(?:아이|어른)(?:를|을|에게|한테)\s*(?:향|바라|쳐다|도와|건네|보)/.test(text)));
    const parts = retained ? retained.split(/(?<=[.!?…])\s+/).map(describeActor).filter((s):s is string=>!!s) : [];
    // In "cries, covers their ears, and takes an adult's hand", the visible
    // action can be between two rejected clauses and have no repeated subject.
    if (!parts.some(earGesture) && /^아이(?:가|는)\s/.test(original) &&
      earGesture(original) && !/않|못|듯|처럼|려고|어른(?:이|은)\s/.test(original)) {
      const earAction = describeActor(coversEars.test(original) ? earCoverNote : '아이가 귀 쪽에 손을 올려요.');
      if (earAction) parts.push(earAction);
    }
    if (hideSecondActor) {
      // An attributive phrase ("smiling, the child ...") may lack a connective
      // which can be closed by the clause editor. Recover only the explicitly
      // named actor's own action when the independent image description agrees.
      for (const actor of original.matchAll(/(?:^|[\s,])(아이가|아이는|어른이|어른은)\s+/g)) {
        const after = original.slice(actor.index + actor[0].length).split(/[,!.?]|(?:아이|어른)(?:가|는|이|은|에게|한테)/)[0]!;
        if (/않|못|듯|처럼/.test(after)) continue;
        const facts: Array<[boolean,RegExp,string]> = [
          [witnesses.some(f=>f.hasSmile), /웃|미소/, '웃어요.'],
          [witnesses.some(f=>f.hasGaze), /고개를?\s*돌/, '고개를 돌려요.'],
          [witnesses.some(f=>f.hasHandMotion), /손을?\s*(?:들|올)/, '손을 들어요.'],
        ];
        for (const [seen, match, predicate] of facts) {
          if (!seen || !match.test(after) || parts.some(p=>match.test(p))) continue;
          const recovered = describeActor(actor[1]+' '+predicate);
          if (recovered) parts.push(recovered);
        }
      }
    }
    return parts.length ? parts.join(' ') : null;
  }

  function cleanText(text:string|null, maxSentences:number, maxLength:number, at:readonly FrameWitness[],
    nearEarGesture=false, nearbyReachUnverified=false):string|null {
    if (!text) return null;
    const sentences = text.split(/(?<=[.!?…])\s+|(?<=요[.!?])(?=[가-힣])/);
    const earCrying = (earGesture(text) || nearEarGesture) && !at.some(f=>f.visibleChildTears);
    const cleaned = sentences.map(sentence=>cleanSentence(sentence,at,earCrying,nearbyReachUnverified)).filter((s): s is string => s !== null);
    if (cleaned.length === sentences.length && cleaned.every((s,i) => s === sentences[i])) return text;
    return cleaned.length ? limitText(cleaned.join(' '), maxSentences, maxLength) : null;
  }
  const moments = obs.moments.flatMap(m => {
    const at = witnesses.filter((_f,i)=>witnessTimes[i] === m.t);
    const nearEarGesture = (raisedHands.test(m.note) || handAtHead.test(m.note)) &&
      earContextTimes.some(t=>Math.abs(t-m.t) <= EAR_GESTURE_RADIUS_SECONDS);
    const nearbyReachUnverified = earTimes.some(t=>Math.abs(t-m.t) <= EAR_GESTURE_RADIUS_SECONDS) && !at.some(f=>f.childReachesAdult);
    let note = cleanText(m.note, Number.POSITIVE_INFINITY, MAX_NOTE_LENGTH, at,nearEarGesture,nearbyReachUnverified);
    if (note && earTimes.includes(m.t) && /^아이(?:가|는)\s/.test(note) && ambiguousHeadGesture(note) && !coversEars.test(note)) {
      const remainder = note.split(/(?<=[.!?…])\s+/).map(sentence=>keepVisibleClauses(sentence,ambiguousHeadGesture))
        .filter(Boolean).join(' ');
      note = limitText([earCoverNote,remainder].filter(Boolean).join(' '),Number.POSITIVE_INFINITY,MAX_NOTE_LENGTH);
    }
    return note ? [{ t:m.t, note }] : [];
  });
  if (!moments.some(m=>coversEars.test(m.note)) && ambiguousHeadGesture(sceneText)) {
    const t = earTimes.find(time=>!moments.some(m=>m.t === time));
    if (t !== undefined && moments.length < MAX_MOMENTS) {
      moments.push({t,note:earCoverNote});
      moments.sort((a,b)=>a.t-b.t);
    }
  }
  const nearEarSummary = !!obs.summary && earContextTimes.length > 0 && (raisedHands.test(obs.summary) || handAtHead.test(obs.summary));
  const unverifiedReachInSummary = earTimes.length > 0 && !witnesses.some(f=>f.childReachesAdult) && !moments.some(m=>towardsAdult.test(m.note));
  let summary = cleanText(obs.summary,MAX_SUMMARY_SENTENCES,MAX_SUMMARY_LENGTH,witnesses,nearEarSummary,unverifiedReachInSummary);
  const childStates = obs.childStates.filter(tag => {
    if (tag === 'THROWING_OR_HITTING') {
      const childStrike = [summary, ...moments.map(m => m.note)].some(text => text?.split(/[.!?…]/).some(s =>
        /아이(?:가|는|들이|들은)\s/.test(s) && !/어른(?:이|은)|않|못|안\s*때|처럼|려고/.test(s) && impactClaim.test(s)));
      return !partial && !adultOnly && childStrike;
    }
    if (tag === 'UPSET_CRYING' && speech.test(sceneText) &&
      !/눈물(?:이|을|자국)|흐느[끼껴]|울먹/.test([summary, ...moments.map(m => m.note)].join(' '))) return false;
    if (tag === 'UPSET_CRYING' && (earContextTimes.length || earGesture(sceneText)) &&
      ![summary, ...moments.map(m=>m.note)].some(note=>note && childCrying.test(note))) return false;
    if (tag === 'PLAYING_TOGETHER') return jointGame;
    if (tag === 'SEEKING_ADULT' && earTimes.length && !moments.some(m=>towardsAdult.test(m.note) &&
      witnesses.some((f,i)=>witnessTimes[i] === m.t && f.childReachesAdult))) return false;
    if (hideSecondActor && (tag === 'SEEKING_ADULT' || soloRole !== 'CLEAR_CHILD')) return false;
    if (tag === 'PLAYING_ALONE') return soloGame;
    return !partial && !(adultOnly && !childInDraft);
  });
  const adultResponses = obs.adultResponses.filter(tag => {
    if (tag === 'JOINING_PLAY') return jointGame;
    if (tag === 'COMFORTING') return !partial && !hideSecondActor && witnessedComfort;
    return tag !== 'TALKING' && !partial && !single && !soloEvidence && !incompatibleAges;
  });
  if (noPeople) return {
    summary:'확인한 장면에서 사람의 동작을 구별하기 어려워요.', childStates:[], adultResponses:[], moments:[], peopleCount:obs.peopleCount,
  };
  if (releasedAt !== null) {
    const action = '손에 들고 있던 물체를 던져요.';
    summary = limitText([action, summary].filter(Boolean).join(' '), MAX_SUMMARY_SENTENCES, MAX_SUMMARY_LENGTH);
    const same = moments.find(m => m.t === releasedAt);
    if (same) same.note = limitText(action + ' ' + same.note, Number.POSITIVE_INFINITY, MAX_NOTE_LENGTH);
    else if (moments.length < MAX_MOMENTS) {
      moments.push({ t:releasedAt, note:action });
      moments.sort((a,b) => a.t-b.t);
    }
  }
  // An affirmative placement in the still remains usable when its coarse person count
  // disagreed with the body description, provided the other checks establish one actor.
  const subject = soloRole === 'CLEAR_CHILD' ? '아이가' : soloRole === 'CLEAR_ADULT' ? '어른이' : '한 사람이';
  if (witnessedSolo && hideSecondActor && (!summary || genericPosture.test(summary))) {
    const objectWitnesses = witnesses.filter(frame => frame.describesObjectPlacement || frame.describesObjectHolding);
    if (objectWitnesses.length >= 2 && objectWitnesses.some(frame => frame.describesObjectPlacement) && describesObjectHandling(physicalText)) {
      summary = subject + ' 물건을 다른 물건 위에 놓아요.';
    }
  }
  if (!summary && hideSecondActor) {
    if (witnesses.some(f=>f.marksSurface) && /그림|그리|그려|찍|무늬|표시|자국|기호|색칠/.test(physicalText)) summary = '손으로 표면에 표시를 해요.';
    else if (placing > 0 && describesObjectHandling(physicalText,true)) summary = subject + ' 물건을 다른 물건 위에 놓아요.';
    else if (holding >= Math.min(2,witnesses.length)) summary = subject + ' 물건 쪽으로 손을 뻗거나 물건을 잡고 있어요.';
    else summary = witnessedSolo ? '화면에 한 사람이 보여요.' : '확인한 장면에서 구체적인 동작을 구별하기 어려워요.';
  }
  if (!summary && !moments.length && hasJointClaim(obs) && !jointGame) {
    summary = '화면에서 구체적인 동작을 확인하기 어려워요.';
  }
  if (!summary && !moments.length && (speech.test(sceneText) || throwClaim.test(sceneText) || otherPersonHand.test(sceneText) ||
      comforting.test(sceneText) || obs.childStates.includes('THROWING_OR_HITTING'))) {
    summary = '확인한 장면에서 구체적인 동작을 구별하기 어려워요.';
  }
  if (!summary && !moments.length && !childStates.length && !adultResponses.length) return null;
  const peopleCount = dropSecondActor ? 1 : obs.peopleCount;
  return { summary, moments, childStates, adultResponses, peopleCount };
}

/**
 * 선생님용 두 줄은 재확인 단계(applyReview)를 거치지 않는다. 그래서 재확인을 지난 요약·메모에 남지 않은 종류의 주장
 * (말소리·대화, 던지기, 부딪치기, 함께 놀기, 놀기)이 한 줄에만 있으면 그 줄을 뺀다. 말소리는 사진으로 확인할 수 없어
 * 재확인이 늘 지우므로, 말소리를 담은 줄은 늘 빠진다. 다른 줄과 태그는 그대로 둔다.
 */
export function screenLines(obs: Observation | null): Observation | null {
  if (!obs || (obs.childLine === undefined && obs.parentLine === undefined)) return obs;
  const reviewed = [obs.summary ?? '', ...obs.moments.map(m => m.note)].join(' ');
  const claims = [speech, throwClaim, impactClaim, together, play, childCrying];
  // A one-line claim has no timestamp to tie it to a checked point of contact.
  const supported = (line: string | undefined) => line !== undefined && !hairClaim.test(line) && !otherPersonHand.test(line) && !comforting.test(line)
    && claims.every(p => !p.test(line) || p.test(reviewed));
  const { childLine, parentLine, ...rest } = obs;
  return {
    ...rest,
    ...(supported(childLine) && { childLine }),
    ...(supported(parentLine) && { parentLine }),
  };
}

export async function reviewedObservation(provider: VisionProvider, request: VisionRequest, frameTimes: readonly number[],
  onEvidence?: (result:{frames:readonly FrameWitness[]; detectedPeople:readonly number[]|null})=>void) {
  const generated = toVisionOutput(await provider.generate(request), provider.modelVersion);
  const raw = parseModelJson(generated.text);
  const draft = normaliseObservation(raw, frameTimes);
  if (!draft) return { ...generated, raw, observation:null };
  const distinctImages = new Set(request.images).size;
  if (distinctImages < 2) {
    draft.childStates = draft.childStates.filter(tag => tag !== 'MOVING_AROUND');
  }
  // A no-person scene without an affirmative role/interaction claim needs no second inference.
  if (draft.peopleCount === 0 && (!draft.summary || draft.summary === '화면에 아이가 보이지 않아요.' ||
    (!/아이|어른/.test(draft.summary) && !speech.test(draft.summary) && !throwClaim.test(draft.summary) && !play.test(draft.summary)))) {
    return { ...generated, raw, observation:draft };
  }
  let review = unknown;
  let releasedAt: number | null = null;
  const text = [draft.summary,...draft.moments.map(m=>m.note)].join(' ');
  const checkFrames = checkablePartnerClaim(draft,/아이/.test(text),/어른/.test(text));
  try {
    request.signal.throwIfAborted();
    const handDescription = handFocus.test(text) && !fullFigureAction.test(text);
    const basePrompt = hasJointClaim(draft) && !handDescription ? partnerPrompt : reviewPrompt;
    const inspectMotion = draft.peopleCount > 0 && distinctImages > 1 && checkObjectMotion(draft) &&
      frameTimes.some((t,i) => i > 0 && t > frameTimes[i - 1]! && t - frameTimes[i - 1]! <= 2);
    const prompt = inspectMotion ? objectMotionPrompt(basePrompt, frameTimes.length) : basePrompt;
    const result = toVisionOutput(await provider.generate({ ...prompt, images:request.images, signal:request.signal }), provider.modelVersion);
    review = decodeReview(result.text);
    if (inspectMotion) releasedAt = releaseTime(result.text, frameTimes, request.images);
  } catch (err) {
    if (request.signal.aborted || err instanceof ProviderTimeoutError) throw err;
    // The draft remains usable for physical descriptions; sound and unverified play still get checked.
  }
  const images = checkFrames ? witnessImages(request.images) : [];
  const [witnesses,boxes] = images.length ? await Promise.all([
    inspectFrames(provider,request,images), independentPeople(images,request.signal),
  ]) : [[],null] as const;
  // Optional local evaluation observer. The HTTP service supplies no observer.
  // Only validated categories and box counts are exposed, never image data or prose.
  onEvidence?.({frames:witnesses, detectedPeople:boxes});
  const checked = applyReview(draft, review, witnesses, boxes, releasedAt,
    images.map(image=>frameTimes[request.images.indexOf(image)]!));
  const present = reconcilePresence(checked,draft);
  const observation = present && await reconcileHairContact(present,provider,request.images,frameTimes,request.signal);
  // 선생님용 두 줄: 재확인 결과가 초안과 다르면 빼고(keepLinesIfUnchanged), 재확인을 지나지 않은 주장이 있으면 그 줄만 뺀다
  // (screenLines). 서로 다른 사진이 두 장 미만이면 시간에 걸친 행동을 확인할 수 없어 뺀다.
  const final = keepLinesIfUnchanged(observation, draft);
  return { ...generated, raw, observation:distinctImages < 2 ? withoutLines(final) : screenLines(final) };
}
