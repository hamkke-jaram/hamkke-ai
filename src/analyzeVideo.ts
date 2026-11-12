/**
 * 영상 1개 → 지표 3개. 모든 처리는 이 브라우저 안에서 끝난다.
 * - 영상 파일은 ObjectURL/ArrayBuffer로만 읽고 fetch·XHR 등 네트워크 API에 넘기지 않는다.
 * - 결과로 숫자(지표 JSON)만 돌려준다.
 */
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import { SAMPLE_RATE, analyzeAudio, type AudioMetrics } from './audio';
import { SAMPLE_STEP_SEC, isTogether, jointPlaySeconds, personFromLandmarks, type Person } from './pose';

export const SPEC_VERSION = 'metrics-v1';
export const MODEL_VERSION = 'pose_landmarker_lite@0.10.35+audio-heuristic-1';
export const MIN_SECONDS = 10;
export const MAX_SECONDS = 1800;
const MAX_FILE_BYTES = 1024 * 1024 * 1024; // 1GB
const FRAME_LONG_SIDE = 640;

export interface DeviceMetrics extends AudioMetrics {
  analyzedSeconds: number;
  jointPlaySeconds: number;
  recordedAt: string;
}

export type Stage = 'loading-model' | 'reading-audio' | 'analyzing-video' | 'done';
export type ProgressFn = (stage: Stage, ratio: number) => void;

export class AnalysisError extends Error {}

/**
 * 오디오 지표 계산기. 기본값은 같은 스레드에서 계산한다.
 * 앱에서는 화면이 멈추지 않도록 Web Worker로 감싼 계산기를 넘긴다(README 참고).
 */
export type AudioRunner = (samples: Float32Array) => Promise<AudioMetrics>;

export const runAudioInThread: AudioRunner = async (samples) => analyzeAudio(samples).metrics;

export interface AnalyzeOptions {
  signal?: AbortSignal;
  runAudio?: AudioRunner;
}

/** 앱은 MediaPipe 파일을 이 경로에서 제공해야 한다(scripts/prepare-models.mjs). */
export const MEDIAPIPE_WASM_PATH = '/mediapipe/wasm';
export const POSE_MODEL_PATH = '/mediapipe/models/pose_landmarker_lite.task';

let landmarkerPromise: Promise<PoseLandmarker> | null = null;

/**
 * VIDEO 모드 PoseLandmarker는 한 인스턴스 안에서 타임스탬프가 계속 커져야 한다.
 * 페이지당 인스턴스 하나를 다시 쓰므로, 두 번째 분석부터도 이전 값보다 큰 값을 넘기도록
 * 마지막으로 넘긴 타임스탬프(ms)를 모듈에 기억해 둔다.
 */
let lastTimestampMs = 0;

/**
 * 분석과 분석 사이에 비워 두는 시간(ms). 같은 인스턴스가 앞 영상의 마지막 프레임 바로 뒤
 * 화면으로 새 영상을 받지 않도록, 프레임 간격(500ms)보다 넉넉히 띄운다.
 */
export const VIDEO_TIMESTAMP_GAP_MS = 10_000;

/** 새 분석을 시작할 때의 기준 시각(ms). 직전에 넘긴 값보다 항상 크고, 분석 사이 간격을 둔다. */
export function videoTimestampBase(lastMs: number): number {
  return Math.floor(lastMs) + 1 + VIDEO_TIMESTAMP_GAP_MS;
}

/**
 * 영상 안 위치 tSec(초)의 프레임에 붙일 타임스탬프(ms).
 * base + 영상 안 위치를 쓰되, 직전 값(lastMs)보다 반드시 1ms 이상 크게 만든다.
 */
export function nextVideoTimestamp(lastMs: number, baseMs: number, tSec: number): number {
  return Math.max(Math.floor(lastMs) + 1, baseMs + Math.round(tSec * 1000));
}

const STOPPED_MESSAGE = '분석을 멈췄어요.';

function throwIfStopped(signal?: AbortSignal) {
  if (signal?.aborted) throw new AnalysisError(STOPPED_MESSAGE);
}

/** 작업을 기다리되, 멈추기를 누르면 바로 끝낸다. 남은 작업의 실패는 조용히 흘려보낸다. (테스트용으로 내보냄) */
export function untilStopped<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) {
    work.catch(() => undefined);
    return Promise.reject(new AnalysisError(STOPPED_MESSAGE));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AnalysisError(STOPPED_MESSAGE));
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

async function getLandmarker(): Promise<PoseLandmarker> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await FilesetResolver.forVisionTasks(MEDIAPIPE_WASM_PATH);
      const options = (delegate: 'GPU' | 'CPU') => ({
        baseOptions: { modelAssetPath: POSE_MODEL_PATH, delegate },
        runningMode: 'VIDEO' as const,
        numPoses: 2,
        minPoseDetectionConfidence: 0.5,
        minPosePresenceConfidence: 0.5,
        minTrackingConfidence: 0.5,
      });
      try {
        return await PoseLandmarker.createFromOptions(fileset, options('GPU'));
      } catch {
        return await PoseLandmarker.createFromOptions(fileset, options('CPU'));
      }
    })();
    landmarkerPromise.catch(() => {
      landmarkerPromise = null;
    });
  }
  return landmarkerPromise;
}

/** 분석 화면에 들어오면 미리 모델을 불러 둔다. */
export function preloadModel() {
  void getLandmarker().catch(() => undefined);
}

function once(target: EventTarget, ok: string, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new AnalysisError('영상을 읽는 데 시간이 너무 오래 걸려요.'));
    }, timeoutMs);
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onErr = () => {
      cleanup();
      reject(new AnalysisError('이 영상 형식은 읽을 수 없어요. 다른 영상으로 시도해 주세요.'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      target.removeEventListener(ok, onOk);
      target.removeEventListener('error', onErr);
    };
    target.addEventListener(ok, onOk);
    target.addEventListener('error', onErr);
  });
}

async function decodeAudio(file: File, durationSec: number): Promise<Float32Array> {
  const buf = await file.arrayBuffer();
  const length = Math.max(1, Math.ceil(durationSec * SAMPLE_RATE));
  const ctx = new OfflineAudioContext(1, length, SAMPLE_RATE);
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } catch {
    throw new AnalysisError('영상의 소리를 읽지 못했어요. 소리가 함께 녹음된 영상으로 다시 시도해 주세요.');
  }
  // 채널 평균 → 모노 (decodeAudioData가 이미 16kHz로 맞춰 준다)
  const out = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / decoded.numberOfChannels;
  }
  return out;
}

export async function analyzeVideo(file: File, onProgress: ProgressFn, options: AnalyzeOptions = {}): Promise<DeviceMetrics> {
  const { signal, runAudio = runAudioInThread } = options;
  if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm|m4v|3gp)$/i.test(file.name)) {
    throw new AnalysisError('영상 파일을 골라 주세요.');
  }
  if (file.size > MAX_FILE_BYTES) {
    throw new AnalysisError('영상이 너무 커요. 3분 안쪽으로 찍은 영상을 권해요.');
  }

  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  video.src = url;
  try {
    throwIfStopped(signal);
    onProgress('loading-model', 0);
    const [landmarker] = await untilStopped(Promise.all([getLandmarker(), once(video, 'loadedmetadata')]), signal);
    throwIfStopped(signal);

    const duration = video.duration;
    if (!Number.isFinite(duration) || duration < MIN_SECONDS) {
      throw new AnalysisError(`영상이 너무 짧아요. ${MIN_SECONDS}초 이상 찍어 주세요.`);
    }
    if (duration > MAX_SECONDS) {
      throw new AnalysisError('영상이 너무 길어요. 30분 이하 영상만 분석할 수 있어요.');
    }

    // 1) 오디오 (워커에서 계산)
    onProgress('reading-audio', 0);
    const samples = await untilStopped(decodeAudio(file, duration), signal);
    throwIfStopped(signal);
    const pendingAudio = runAudio(samples);
    // 프레임 분석 중 멈추면 이 결과를 기다리지 않는다. 나중에 실패해도 처리되지 않은 거부로 남지 않게 한다.
    pendingAudio.catch(() => undefined);

    // 2) 영상 프레임 (0.5초 간격)
    if (video.readyState < 2) await untilStopped(once(video, 'loadeddata'), signal);
    throwIfStopped(signal);
    const scale = FRAME_LONG_SIDE / Math.max(video.videoWidth, video.videoHeight, 1);
    const w = Math.max(1, Math.round(video.videoWidth * Math.min(1, scale)));
    const h = Math.max(1, Math.round(video.videoHeight * Math.min(1, scale)));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const g = canvas.getContext('2d', { willReadFrequently: false });
    if (!g) throw new AnalysisError('이 브라우저에서는 분석할 수 없어요.');

    const together: boolean[] = [];
    const steps = Math.floor(duration / SAMPLE_STEP_SEC);
    const baseMs = videoTimestampBase(lastTimestampMs);
    for (let i = 0; i < steps; i++) {
      throwIfStopped(signal);
      const t = i * SAMPLE_STEP_SEC;
      const seeked = once(video, 'seeked');
      video.currentTime = t;
      await untilStopped(seeked, signal);
      g.drawImage(video, 0, 0, w, h);
      // 같은 인스턴스를 다시 쓰므로 이전 분석보다 큰 타임스탬프를 넘긴다.
      lastTimestampMs = nextVideoTimestamp(lastTimestampMs, baseMs, t);
      const result = landmarker.detectForVideo(canvas, lastTimestampMs);
      const people = result.landmarks
        .map((lm) => personFromLandmarks(lm, w, h))
        .filter((p): p is Person => p !== null);
      together.push(isTogether(people));
      onProgress('analyzing-video', (i + 1) / steps);
    }

    throwIfStopped(signal);
    const audio = await untilStopped(pendingAudio, signal);
    throwIfStopped(signal);
    const analyzedSeconds = Math.round(Math.min(duration, MAX_SECONDS) * 10) / 10;
    const joint = Math.min(analyzedSeconds, jointPlaySeconds(together));

    // 촬영 시각: 파일 수정 시각(카메라로 바로 찍으면 촬영 시각). 미래 값이면 지금으로.
    const modified = file.lastModified && file.lastModified <= Date.now() ? file.lastModified : Date.now();
    onProgress('done', 1);
    return {
      ...audio,
      analyzedSeconds,
      jointPlaySeconds: joint,
      recordedAt: new Date(modified).toISOString(),
    };
  } finally {
    video.removeAttribute('src');
    video.load();
    URL.revokeObjectURL(url);
  }
}
