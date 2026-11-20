// Compare the released analytic rule on exactly the PCM used by the classifier.
import { readFileSync } from 'node:fs';
import { analyzeAudio } from '../../src/audio.ts';

for (const { name, pcm } of JSON.parse(readFileSync(0, 'utf8'))) {
  const bytes = Buffer.from(pcm, 'base64');
  const samples = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4);
  const { distressEpisodeCount } = analyzeAudio(samples).metrics;
  process.stdout.write(JSON.stringify({ name, detected: distressEpisodeCount > 0 }) + '\n');
}
