// 한 번 쓴 분석 토큰(jti)을 만료 시각까지 메모리에 기억한다. 서버를 다시 켜면 비워진다
// (그 사이 토큰을 다시 써도 hamkke-api 가 영수증의 jti 를 DB unique 로 한 번 더 막는다).

export interface JtiStore {
  /** 아직 만료되지 않은 jti 를 기억하고 있는지. */
  has(jti: string, nowMs: number): boolean;
  /** 기억한다. 이미 있거나 자리가 없으면 false. */
  add(jti: string, expiresAtMs: number, nowMs: number): boolean;
  /** 처리를 시작하지 못한 요청의 jti 를 되돌린다. */
  delete(jti: string): void;
  readonly size: number;
}

const SWEEP_INTERVAL_MS = 30_000;

export function createJtiStore(maxEntries = 100_000): JtiStore {
  const entries = new Map<string, number>();
  let lastSweep = 0;

  function sweep(nowMs: number): void {
    lastSweep = nowMs;
    for (const [jti, expiresAt] of entries) if (expiresAt <= nowMs) entries.delete(jti);
  }

  function has(jti: string, nowMs: number): boolean {
    const expiresAt = entries.get(jti);
    if (expiresAt === undefined) return false;
    if (expiresAt <= nowMs) {
      entries.delete(jti);
      return false;
    }
    return true;
  }

  return {
    has,
    add(jti, expiresAtMs, nowMs) {
      if (nowMs - lastSweep >= SWEEP_INTERVAL_MS || entries.size >= maxEntries) sweep(nowMs);
      if (has(jti, nowMs) || entries.size >= maxEntries) return false;
      entries.set(jti, expiresAtMs);
      return true;
    },
    delete(jti) {
      entries.delete(jti);
    },
    get size() {
      return entries.size;
    },
  };
}
