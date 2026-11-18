/**
 * 기기 분석 엣지 케이스 페이지: 합성 영상마다 analyzeVideo 를 돌려 오류로 끝나는지, 숫자가 말이 되는지
 * (음수·NaN·함께한 시간 > 분석 시간), 시간·메모리를 본다. 결과는 window.__edge 에도 둔다(자동 확인용).
 */
import { analyzeVideo, type DeviceMetrics } from '../src';

interface Item {
  file: string;
  label: string;
  expect: 'ok' | 'error';
  bytes: number;
}

interface Row {
  file: string;
  label: string;
  expect: string;
  result: 'ok' | 'error';
  matches: boolean;
  sec: number;
  peakHeapMB: number | null;
  error?: string;
  metrics?: DeviceMetrics;
  problems: string[];
}

const status = document.getElementById('status')!;
const table = document.getElementById('table') as HTMLTableElement;
const rows: Row[] = [];
(window as unknown as { __edge: { rows: Row[]; done: boolean } }).__edge = { rows, done: false };

/** 숫자가 말이 되는지. 문제 목록(빈 배열이면 통과). */
export function metricProblems(m: DeviceMetrics): string[] {
  const problems: string[] = [];
  const num = (name: string, v: unknown, nullable = false) => {
    if (v === null && nullable) return;
    if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${name} 숫자 아님`);
    else if (v < 0) problems.push(`${name} 음수`);
  };
  num('analyzedSeconds', m.analyzedSeconds);
  num('jointPlaySeconds', m.jointPlaySeconds);
  num('responseLatencySec', m.responseLatencySec, true);
  num('distressEpisodeCount', m.distressEpisodeCount);
  if (m.jointPlaySeconds > m.analyzedSeconds + 0.5) problems.push('함께한 시간 > 분석 시간');
  return problems;
}

function esc(s: string) {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
}

function render() {
  table.innerHTML =
    '<tr><th>파일</th><th>설명</th><th>기대</th><th>결과</th><th>시간</th><th>최대 힙</th><th>함께/분석(초)</th><th>반응</th><th>울음</th><th>문제·오류 문구</th></tr>' +
    rows
      .map((r) => {
        const m = r.metrics;
        return `<tr><td>${esc(r.file)}</td><td>${esc(r.label)}</td><td>${r.expect}</td><td>${r.matches ? '' : '✗ '}${r.result}</td>
          <td>${r.sec.toFixed(1)}s</td><td>${r.peakHeapMB ?? '–'}MB</td>
          <td>${m ? `${m.jointPlaySeconds}/${m.analyzedSeconds}` : '–'}</td><td>${m ? (m.responseLatencySec ?? 'null') : '–'}</td>
          <td>${m ? m.distressEpisodeCount : '–'}</td><td>${esc([...r.problems, r.error ?? ''].filter(Boolean).join(' · '))}</td></tr>`;
      })
      .join('');
}

async function run() {
  const only = new URLSearchParams(location.search).get('only')?.split(',');
  let items = (await (await fetch('/edge-videos/manifest.json')).json()) as Item[];
  if (only) items = items.filter((i) => only.includes(i.file));
  for (const [n, item] of items.entries()) {
    status.textContent = `${n + 1}/${items.length} ${item.file} 분석 중…`;
    const blob = await (await fetch(`/edge-videos/${item.file}`)).blob();
    const type = item.file.endsWith('.m4a') ? 'audio/mp4' : 'video/mp4';
    const file = new File([blob], item.file, { type });
    const memory = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    let peak = memory?.usedJSHeapSize ?? 0;
    const t0 = performance.now();
    const row: Row = { file: item.file, label: item.label, expect: item.expect, result: 'ok', matches: false, sec: 0, peakHeapMB: null, problems: [] };
    try {
      row.metrics = await analyzeVideo(file, () => {
        const used = memory?.usedJSHeapSize;
        if (used && used > peak) peak = used;
      });
      row.problems = metricProblems(row.metrics);
    } catch (err) {
      row.result = 'error';
      row.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    row.sec = (performance.now() - t0) / 1000;
    row.peakHeapMB = peak ? Math.round(peak / 1e6) : null;
    row.matches = row.result === item.expect && row.problems.length === 0;
    rows.push(row);
    render();
  }
  const wrong = rows.filter((r) => !r.matches).length;
  status.textContent = `끝: ${rows.length}개 중 기대와 다름 ${wrong}개`;
  (window as unknown as { __edge: { done: boolean } }).__edge.done = true;
}

run().catch((e) => {
  status.textContent = `오류: ${e instanceof Error ? e.message : String(e)}`;
  (window as unknown as { __edge: { done: boolean } }).__edge.done = true;
});
