/**
 * 로컬 평가 페이지: 같은 analyzeVideo 코드로 여러 영상을 분석하고 사람이 잰 값과 비교한다.
 * 결과는 내부 개선용이다. 앱·발표에 "○○%" 같은 수치로 쓰지 않는다(지표 정의서 5장).
 */
import { analyzeVideo, type DeviceMetrics } from '../src';

type Label = { jointPlaySeconds?: number; responseLatencySec?: number | null; distressEpisodeCount?: number };
type Row = { name: string; m?: DeviceMetrics; label?: Label; error?: string };

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const videosInput = $<HTMLInputElement>('videos');
const labelsInput = $<HTMLInputElement>('labels');
const runBtn = $<HTMLButtonElement>('run');
const csvBtn = $<HTMLButtonElement>('csv');
const status = $<HTMLSpanElement>('status');
const table = $<HTMLTableElement>('table');
const summary = $<HTMLParagraphElement>('summary');

let labels: Record<string, Label> = {};
let rows: Row[] = [];

videosInput.addEventListener('change', () => {
  runBtn.disabled = !videosInput.files?.length;
});

labelsInput.addEventListener('change', async () => {
  const f = labelsInput.files?.[0];
  try {
    labels = f ? JSON.parse(await f.text()) : {};
    status.textContent = f ? `라벨 ${Object.keys(labels).length}개 읽음` : '';
  } catch {
    labels = {};
    status.textContent = '라벨 JSON 형식이 올바르지 않아요.';
  }
});

const fmt = (v: number | null | undefined, d = 1) => (v == null ? '–' : v.toFixed(d));
const diff = (a: number | null | undefined, b: number | null | undefined, d = 1) =>
  a == null || b == null ? '–' : (a - b >= 0 ? '+' : '') + (a - b).toFixed(d);

function render() {
  const head =
    '<tr><th>영상</th><th>길이(초)</th><th>함께(기기)</th><th>함께(사람)</th><th>차이</th>' +
    '<th>반응(기기)</th><th>반응(사람)</th><th>차이</th><th>울음(기기)</th><th>울음(사람)</th><th>차이</th></tr>';
  const body = rows
    .map((r) => {
      if (r.error) return `<tr><td>${esc(r.name)}</td><td colspan="10" style="text-align:left">${esc(r.error)}</td></tr>`;
      if (!r.m) return `<tr><td>${esc(r.name)}</td><td colspan="10" style="text-align:left">대기 중</td></tr>`;
      const l = r.label ?? {};
      return `<tr><td>${esc(r.name)}</td><td>${fmt(r.m.analyzedSeconds)}</td>
        <td>${fmt(r.m.jointPlaySeconds)}</td><td>${fmt(l.jointPlaySeconds)}</td><td>${diff(r.m.jointPlaySeconds, l.jointPlaySeconds)}</td>
        <td>${fmt(r.m.responseLatencySec, 2)}</td><td>${fmt(l.responseLatencySec, 2)}</td><td>${diff(r.m.responseLatencySec, l.responseLatencySec, 2)}</td>
        <td>${r.m.distressEpisodeCount}</td><td>${l.distressEpisodeCount ?? '–'}</td><td>${diff(r.m.distressEpisodeCount, l.distressEpisodeCount, 0)}</td></tr>`;
    })
    .join('');
  table.innerHTML = head + body;

  const done = rows.filter((r) => r.m && r.label);
  const mae = (pick: (r: Row) => [number | null | undefined, number | null | undefined]) => {
    const ds = done.map(pick).filter(([a, b]) => a != null && b != null).map(([a, b]) => Math.abs((a as number) - (b as number)));
    return ds.length ? `${(ds.reduce((s, x) => s + x, 0) / ds.length).toFixed(2)} (n=${ds.length})` : '–';
  };
  summary.textContent = done.length
    ? `평균 절대 차이 — 함께한 시간(초): ${mae((r) => [r.m!.jointPlaySeconds, r.label!.jointPlaySeconds])}, ` +
      `반응 시간(초): ${mae((r) => [r.m!.responseLatencySec, r.label!.responseLatencySec])}, ` +
      `울음 횟수: ${mae((r) => [r.m!.distressEpisodeCount, r.label!.distressEpisodeCount])}`
    : '';
}

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

runBtn.addEventListener('click', async () => {
  const files = Array.from(videosInput.files ?? []);
  rows = files.map((f) => ({ name: f.name, label: labels[f.name] }));
  runBtn.disabled = true;
  csvBtn.disabled = true;
  render();
  for (let i = 0; i < files.length; i++) {
    try {
      rows[i].m = await analyzeVideo(files[i], (_stage, ratio) => {
        status.textContent = `${i + 1}/${files.length} ${files[i].name} — ${Math.round(ratio * 100)}%`;
      });
    } catch (e) {
      rows[i].error = e instanceof Error ? e.message : String(e);
    }
    render();
  }
  status.textContent = '완료';
  runBtn.disabled = false;
  csvBtn.disabled = false;
});

csvBtn.addEventListener('click', () => {
  const header = 'file,analyzedSeconds,jointPlay_device,jointPlay_human,latency_device,latency_human,distress_device,distress_human,childBids,respondedBids';
  const lines = rows.map((r) =>
    [
      `"${r.name.replace(/"/g, '""')}"`,
      r.m?.analyzedSeconds ?? '',
      r.m?.jointPlaySeconds ?? '',
      r.label?.jointPlaySeconds ?? '',
      r.m?.responseLatencySec ?? '',
      r.label?.responseLatencySec ?? '',
      r.m?.distressEpisodeCount ?? '',
      r.label?.distressEpisodeCount ?? '',
      r.m?.childBidCount ?? '',
      r.m?.respondedBidCount ?? '',
    ].join(','),
  );
  const blob = new Blob(['﻿' + [header, ...lines].join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `eval-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  // 바로 해제하면 브라우저가 내려받기를 취소할 수 있어 잠시 뒤에 해제한다.
  const href = a.href;
  setTimeout(() => URL.revokeObjectURL(href), 1000);
});
