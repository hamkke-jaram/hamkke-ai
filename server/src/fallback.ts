// 대신 쓰는 모델(VL_FALLBACK_MODEL). 첫 모델에 닿지 못하거나 쓸 수 없을 때(ProviderUnavailableError)만 넘어간다.
// - 제한 시간이 지났거나 요청한 쪽이 끊은 호출은 넘기지 않는다(같은 신호로 끝나야 한다).
// - 대신 쓴 모델이 쓴 글이면 그 모델 이름을 함께 돌려준다 → 영수증 mv 와 응답 modelVersion 이 실제 모델이 된다.
// - 첫 모델이 실패하면 잠시(PRIMARY_COOLDOWN_MS) 첫 모델을 건너뛰어, 요청마다 실패를 기다리지 않게 한다.
import { ProviderUnavailableError, toVisionOutput } from './provider.ts';
import type { VisionOutput, VisionProvider, VisionRequest } from './provider.ts';

export const PRIMARY_COOLDOWN_MS = 30_000;

export interface FallbackOptions {
  /** 지금 시각(밀리초). 테스트에서 바꿔 끼운다. */
  now?: () => number;
  cooldownMs?: number;
  /** 대신 쓰는 모델로 넘어갈 때마다 불린다(로그·지표용). detail 은 첫 모델이 실패한 짧은 코드. */
  onFallback?: (detail: string) => void;
}

export function createFallbackProvider(primary: VisionProvider, fallback: VisionProvider, options: FallbackOptions = {}): VisionProvider {
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? PRIMARY_COOLDOWN_MS;
  let primaryFailedAt: number | null = null;

  async function viaFallback(request: VisionRequest, detail: string): Promise<VisionOutput> {
    options.onFallback?.(detail);
    const result = await fallback.generate(request);
    // 대신 쓰는 모델이 또 다른 모델 이름을 알려 주면 그 이름을 쓴다.
    return toVisionOutput(result, fallback.modelVersion);
  }

  async function generate(request: VisionRequest): Promise<VisionOutput> {
    if (primaryFailedAt !== null && now() - primaryFailedAt < cooldownMs) {
      return viaFallback(request, 'primary_cooldown');
    }
    try {
      const result = await primary.generate(request);
      primaryFailedAt = null;
      return toVisionOutput(result, primary.modelVersion);
    } catch (err) {
      if (!(err instanceof ProviderUnavailableError) || request.signal.aborted) throw err;
      primaryFailedAt = now();
      return viaFallback(request, err.detail);
    }
  }

  async function isReady(signal: AbortSignal): Promise<boolean> {
    const [first, second] = await Promise.all([
      primary.isReady(signal).catch(() => false),
      fallback.isReady(signal).catch(() => false),
    ]);
    if (first) primaryFailedAt = null; // 첫 모델이 돌아왔으면 바로 다시 쓴다
    return first === true || second === true;
  }

  async function warmUp(signal: AbortSignal): Promise<void> {
    // 같은 GPU 에 두 모델을 함께 올리면 서로 밀어낼 수 있어 첫 모델만 올린다.
    if (primary.warmUp) await primary.warmUp(signal);
  }

  return {
    modelVersion: primary.modelVersion,
    fallbackModelVersion: fallback.modelVersion,
    generate,
    isReady,
    warmUp,
  };
}
