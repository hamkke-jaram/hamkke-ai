/**
 * 함께 노는 시간 계산 (지표 정의서 metrics-v1 ①).
 * 이 파일의 함수는 순수 계산만 하며, 프레임 좌표는 기기 밖으로 나가지 않는다.
 */

export interface Landmark {
  x: number; // 0~1 (프레임 너비 기준)
  y: number; // 0~1 (프레임 높이 기준)
  visibility?: number;
}

export interface Person {
  cx: number; // 픽셀
  cy: number;
  torso: number; // 픽셀
}

export const SAMPLE_STEP_SEC = 0.5;
const TOGETHER_FACTOR = 2.5;
const VIS_MIN = 0.3;

const L_SHOULDER = 11;
const R_SHOULDER = 12;
const L_HIP = 23;
const R_HIP = 24;

function visible(l: Landmark | undefined): l is Landmark {
  return !!l && (l.visibility ?? 1) >= VIS_MIN;
}

/** 랜드마크 33개에서 몸통 중심과 몸통 길이를 구한다. 어깨가 안 보이면 null. */
export function personFromLandmarks(lm: Landmark[], width: number, height: number): Person | null {
  const ls = lm[L_SHOULDER];
  const rs = lm[R_SHOULDER];
  if (!visible(ls) || !visible(rs)) return null;
  const sx = ((ls.x + rs.x) / 2) * width;
  const sy = ((ls.y + rs.y) / 2) * height;
  const lh = lm[L_HIP];
  const rh = lm[R_HIP];
  if (visible(lh) && visible(rh)) {
    const hx = ((lh.x + rh.x) / 2) * width;
    const hy = ((lh.y + rh.y) / 2) * height;
    return { cx: (sx + hx) / 2, cy: (sy + hy) / 2, torso: Math.hypot(hx - sx, hy - sy) };
  }
  // 엉덩이가 화면 밖이면 어깨너비로 몸통 길이를 어림한다.
  const shoulderWidth = Math.hypot((ls.x - rs.x) * width, (ls.y - rs.y) * height);
  return { cx: sx, cy: sy + shoulderWidth * 0.6, torso: shoulderWidth * 1.2 };
}

export function isTogether(people: Person[]): boolean {
  if (people.length < 2) return false;
  const [a, b] = [...people].sort((p, q) => q.torso - p.torso);
  const meanTorso = (a.torso + b.torso) / 2;
  if (meanTorso <= 0) return false;
  return Math.hypot(a.cx - b.cx, a.cy - b.cy) <= meanTorso * TOGETHER_FACTOR;
}

/** 샘플 프레임별 "함께" 여부 → 함께 노는 시간(초). 한 프레임짜리 끊김은 메운다. */
export function jointPlaySeconds(together: boolean[], stepSec = SAMPLE_STEP_SEC): number {
  const filled = together.map((v, i) => v || (i > 0 && i < together.length - 1 && together[i - 1] && together[i + 1]));
  const count = filled.filter(Boolean).length;
  return Math.round(count * stepSec * 10) / 10;
}
