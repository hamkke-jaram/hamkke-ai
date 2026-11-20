import { readFile } from 'node:fs/promises';
import { createOllamaProvider } from '../../src/ollama.ts';
import { CORPUS_VERSION, findEvidence, groundRecommendations } from '../../src/observationEvidence.ts';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length && args[0] !== '--fresh')) {
  throw new Error('Usage: node server/eval/evidence/run.mjs [--fresh]');
}
const dataset = args.length ? 'fresh' : 'base';
const scenes = JSON.parse(await readFile(new URL(dataset + '.json', import.meta.url), 'utf8'));
const model = createOllamaProvider({
  baseUrl: 'http://127.0.0.1:11434', model: 'qwen3.5:4b', keepAlive: '5m',
  numCtx: 8192, maxOutputTokens: 1500, localOnly: true,
});
// The labels predate the two subtopics used by the expanded corpus.
const activityFamily = { 'pretend-cook': 'pretend', 'ball-kick': 'ball' };
const observations = [];
for (const [age, observation, ...expected] of scenes) {
  const candidates = findEvidence([observation], age);
  const recommendations = await groundRecommendations(model, candidates, AbortSignal.timeout(45000));
  const selected = recommendations.map(item => ({
    id: item.sourceId,
    topic: candidates.find(candidate => candidate.passage.id === item.sourceId).passage.topic,
    action: item.action,
  }));
  const correct = expected.length
    ? selected.length > 0 && selected.every(item => expected.includes(activityFamily[item.topic] ?? item.topic))
    : selected.length === 0;
  observations.push({ age, observation, expected, selected, correct });
}
const expectedRecommendations = observations.filter(row => row.expected.length);
const expectedAbstentions = observations.filter(row => !row.expected.length);
const summary = {
  corpus: CORPUS_VERSION, model: model.modelVersion, dataset,
  positive: expectedRecommendations.filter(row => row.correct).length, positiveCount: expectedRecommendations.length,
  abstained: expectedAbstentions.filter(row => row.correct).length, negativeCount: expectedAbstentions.length,
};
console.log(JSON.stringify({ summary, observations }, null, 2));
