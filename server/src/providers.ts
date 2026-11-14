// 환경 변수(Config)로 모델 제공자를 만든다. 서버(index.ts)와 평가 도구(server/eval/vl-eval.ts)가 함께 쓴다.
import type { Config } from './config.ts';
import { createFallbackProvider } from './fallback.ts';
import { createOllamaProvider } from './ollama.ts';
import type { VisionProvider } from './provider.ts';

export interface ProviderHooks {
  /** 대신 쓰는 모델로 넘어갈 때. detail 은 첫 모델이 실패한 짧은 코드(사진·문장 없음). */
  onFallback?: (detail: string) => void;
  /** 테스트에서 바꿔 끼우는 fetch. */
  fetchImpl?: typeof fetch;
}

/** VL_MODEL 의 Ollama 제공자. VL_FALLBACK_MODEL 이 있으면 대신 쓰는 모델을 뒤에 붙인다. */
export function createProviderFromConfig(config: Config, hooks: ProviderHooks = {}): VisionProvider {
  const common = {
    keepAlive: config.keepAlive,
    numCtx: config.numCtx,
    maxOutputTokens: config.maxOutputTokens,
    authHeader: config.ollamaAuth,
    fetchImpl: hooks.fetchImpl,
  };
  const primary = createOllamaProvider({ ...common, baseUrl: config.ollamaUrl, model: config.model });
  if (config.fallbackModel === null) return primary;
  const fallback = createOllamaProvider({ ...common, baseUrl: config.fallbackUrl, model: config.fallbackModel });
  return createFallbackProvider(primary, fallback, { onFallback: hooks.onFallback });
}
