import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_FRAME_BYTES } from './frames.ts';

const worker = fileURLToPath(new URL('../vision/person_count.py', import.meta.url));
const localPython = fileURLToPath(new URL(process.platform === 'win32' ?
  '../vision/.venv/Scripts/python.exe' : '../vision/.venv/bin/python', import.meta.url));

/** Returns visible person-box counts for the given frames, or null when the detector abstains.
 * Zero means the detector found no box; people can still be present or partly hidden. */
export async function independentPeople(images: readonly string[], signal: AbortSignal): Promise<number[] | null> {
  signal.throwIfAborted();
  const python = process.env.HAMKKE_PERSON_PYTHON || localPython;
  if (!images.length || images.length > 3 || !existsSync(python) || !existsSync(worker) ||
      images.some(s => !s.startsWith('/9j/') || s.length < 350 || s.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4)) return null;
  const result = await new Promise<number[] | null>((resolve) => {
    const child = spawn(python, ['-I', '-B', worker], { windowsHide:true, stdio:['pipe','pipe','ignore'] });
    let output = '';
    function stop() { child.kill(); }
    const timer = setTimeout(stop, 9000);
    timer.unref();
    signal.addEventListener('abort', stop, {once:true});
    function finish(value:number[] | null) {
      clearTimeout(timer);
      signal.removeEventListener('abort',stop);
      resolve(value);
    }
    child.on('error',()=>finish(null));
    child.stdin.on('error',stop);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',(chunk:string)=>{
      output += chunk;
      if (output.length > 128) stop();
    });
    child.on('close',code=>{
      if (code !== 0 || output.length > 128) return finish(null);
      try {
        const counts:unknown = JSON.parse(output);
        finish(Array.isArray(counts) && counts.length === images.length &&
          counts.every(n=>Number.isInteger(n) && n>=0 && n<=80) ? counts : null);
      } catch { finish(null); }
    });
    child.stdin.end(JSON.stringify(images));
  });
  signal.throwIfAborted();
  return result;
}
