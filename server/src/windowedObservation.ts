import {
  limitText, MAX_MOMENTS, MAX_SUMMARY_LENGTH, MAX_SUMMARY_SENTENCES, MAX_TAGS, type Moment, type Observation,
} from './observation.ts';

export const WINDOWED_PROMPT_VERSION = 'obs-v6.5-windowed';

const childSubject = /(?:아이|유아|영아|어린이|아기)(?:가|는)(?=\s)/;
const crying = /(?:아이|유아|영아|어린이|아기)(?:가|는)\s[^.!?…]{0,48}(?:울고|울어요|울었|흐느[끼껴])/;

function importance(note: string): number {
  if (crying.test(note) || note.includes('손에 들고 있던 물체를 던져요.')) return 2;
  return childSubject.test(note) ? 1 : 0;
}

function byImportance(a: Moment, b: Moment): number {
  return importance(b.note) - importance(a.note) || a.t - b.t;
}

/**
 * Join already checked observations without another model pass. The same person can be
 * visible in several windows, so carry the highest simultaneous count. Reserve one
 * moment per window before filling remaining slots. All output text keeps its source.
 */
export function mergeWindowObservations(windows: readonly Observation[]): Observation {
  const occupied = windows.filter(window => window.peopleCount > 0);
  if (occupied.length === 0) return windows[0]!;

  const preferred: Moment[] = [];
  const additional: Moment[] = [];
  for (const window of occupied) {
    const [first, ...more] = [...window.moments].sort(byImportance);
    if (first) preferred.push(first);
    additional.push(...more);
  }

  const checked = [...preferred.sort(byImportance), ...additional.sort(byImportance)];
  const momentByNote = new Map<string, Moment>();
  for (const moment of checked) {
    if (!momentByNote.has(moment.note)) momentByNote.set(moment.note, moment);
  }
  const moments = [...momentByNote.values()].slice(0, MAX_MOMENTS).sort((a, b) => a.t - b.t);
  const notableSummaries = occupied.flatMap(window => window.summary ? [window.summary] : [])
    .flatMap(summary => summary.split(/(?<=[.!?…])\s+/))
    .filter(sentence => importance(sentence) === 2);
  const summaryNotes = [...new Set([...moments.map(moment => moment.note), ...notableSummaries])]
    .sort((a, b) => importance(b) - importance(a));
  const fallback = occupied.find(window => window.summary)?.summary ?? null;

  const childStates = [...new Set(occupied.flatMap(window => window.childStates))];
  const hasCrying = summaryNotes.some(note => crying.test(note));
  const visibleChildStates = childStates.filter(tag => tag !== 'UPSET_CRYING' || hasCrying);
  if (visibleChildStates.includes('UPSET_CRYING')) {
    visibleChildStates.sort((a, b) => Number(b === 'UPSET_CRYING') - Number(a === 'UPSET_CRYING'));
  }
  return {
    summary: summaryNotes.length ? limitText(summaryNotes.join(' '), MAX_SUMMARY_SENTENCES, MAX_SUMMARY_LENGTH) : fallback,
    childStates: visibleChildStates.slice(0, MAX_TAGS),
    adultResponses: [...new Set(occupied.flatMap(window => window.adultResponses))].slice(0, MAX_TAGS),
    moments,
    peopleCount: Math.max(...occupied.map(window => window.peopleCount)),
  };
}
