/**
 * @hamkke-jaram/analysis — 함께자람 기기 내 상호작용 분석 (지표 정의서 metrics-v1)
 * 영상·소리는 브라우저 안에서만 처리하고, 숫자 지표만 돌려준다.
 */
export {
  AnalysisError,
  MAX_SECONDS,
  MEDIAPIPE_WASM_PATH,
  MIN_SECONDS,
  MODEL_VERSION,
  POSE_MODEL_PATH,
  SPEC_VERSION,
  analyzeVideo,
  preloadModel,
  runAudioInThread,
  type AnalyzeOptions,
  type AudioRunner,
  type DeviceMetrics,
  type ProgressFn,
  type Stage,
} from './analyzeVideo';
export { SAMPLE_RATE, analyzeAudio, estimatePitch, type AudioAnalysis, type AudioMetrics, type Segment } from './audio';
export { SAMPLE_STEP_SEC, isTogether, jointPlaySeconds, personFromLandmarks, type Landmark, type Person } from './pose';
