// 요청 본문 읽기와 장면 사진 검사 (hamkke-api docs/ai-observation.md 5장).
// 사진은 메모리에서만 다룬다. 디코딩한 바이트는 검사가 끝나면 바로 0으로 덮는다.

export const MAX_FRAMES = 6;
export const MAX_FRAME_BYTES = 300 * 1024;
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** 웹은 긴 변 512px 로 보낸다. 모델 서버가 아주 큰 그림을 펼치지 않도록 한 변의 상한을 둔다. */
export const MAX_FRAME_SIDE_PX = 2048;
export const MIN_FRAME_SIDE_PX = 16;
/** 사진 시각·영상 길이로 받아들이는 가장 큰 값(초). */
export const MAX_SECONDS = 24 * 60 * 60;

const MAX_JSON_DEPTH = 6;
const MAX_BASE64_LENGTH = Math.ceil(MAX_FRAME_BYTES / 3) * 4;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

export interface Frame {
  /** 영상 안에서의 시각(초). 보낸 값 그대로. */
  t: number;
  /** JPEG 의 base64 문자열. 모델 호출이 끝나면 참조를 버린다. */
  jpeg: string;
}

export interface AnalyzeInput {
  frames: Frame[];
  durationSec: number | null;
}

export class BodyTooLargeError extends Error {
  constructor() {
    super('body too large');
    this.name = 'BodyTooLargeError';
  }
}

/** 본문·사진을 받아들일 수 없는 까닭. 로그에만 남긴다(본문 내용은 담지 않는다). */
export class FrameError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super('frames rejected');
    this.name = 'FrameError';
    this.reason = reason;
  }
}

/** 본문을 읽으면서 크기를 센다. 상한을 넘는 순간 읽기를 멈추고 모아 둔 조각을 지운다. */
export async function readBody(body: AsyncIterable<Uint8Array>, limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for await (const chunk of body) {
      total += chunk.byteLength;
      if (total > limit) throw new BodyTooLargeError();
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, total);
  } finally {
    for (const chunk of chunks) chunk.fill(0);
    chunks.length = 0;
  }
}

/** 중첩 깊이가 상한 안쪽인지 문자열 밖의 괄호만 세어 확인한다. */
export function jsonDepthWithin(text: string, maxDepth: number): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      // 문자열 끝까지 건너뛴다(역슬래시 다음 글자는 넘긴다).
      i++;
      while (i < text.length) {
        const s = text.charCodeAt(i);
        if (s === 0x5c) i++;
        else if (s === 0x22) break;
        i++;
      }
    } else if (c === 0x7b || c === 0x5b) {
      depth++;
      if (depth > maxDepth) return false;
    } else if (c === 0x7d || c === 0x5d) {
      depth--;
    }
  }
  return true;
}

/**
 * JPEG 머리 부분을 훑어 가로·세로 크기를 읽는다. 시작 바이트(FF D8 FF)가 아니거나
 * 크기 정보(SOF)에 닿기 전에 구조가 어긋나면 null.
 */
export function readJpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) {
      i++; // 채움 바이트
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // 길이가 없는 표식
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // 크기 정보 없이 끝나거나 그림 자료가 시작됨
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (length < 2 || i + 2 + length > bytes.length) return null;
    const isSizeSegment = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSizeSegment) {
      if (length < 8) return null;
      return {
        height: (bytes[i + 5]! << 8) | bytes[i + 6]!,
        width: (bytes[i + 7]! << 8) | bytes[i + 8]!,
      };
    }
    i += 2 + length;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_SECONDS;
}

function checkJpeg(base64: unknown): string {
  if (typeof base64 !== 'string') throw new FrameError('jpeg_type');
  if (base64.length > MAX_BASE64_LENGTH) throw new FrameError('frame_too_large');
  if (base64.length < 8 || base64.length % 4 !== 0 || !BASE64.test(base64)) throw new FrameError('base64');
  const bytes = Buffer.from(base64, 'base64');
  try {
    if (bytes.length > MAX_FRAME_BYTES) throw new FrameError('frame_too_large');
    const size = readJpegSize(bytes);
    if (size === null) throw new FrameError('not_jpeg');
    const longest = Math.max(size.width, size.height);
    const shortest = Math.min(size.width, size.height);
    if (longest > MAX_FRAME_SIDE_PX || shortest < MIN_FRAME_SIDE_PX) throw new FrameError('frame_dimensions');
  } finally {
    bytes.fill(0);
  }
  return base64;
}

/**
 * 본문(JSON)을 해석하고 사진을 검사한다. 넘겨받은 raw 는 해석 뒤 0으로 덮는다.
 * 돌려주는 frames 는 시각 순서로 정렬되어 있다.
 */
export function parseAnalyzeBody(raw: Buffer): AnalyzeInput {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    throw new FrameError('encoding');
  } finally {
    raw.fill(0);
  }
  if (!jsonDepthWithin(text, MAX_JSON_DEPTH)) throw new FrameError('json_depth');
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // 해석기의 오류 문장에는 본문 일부가 들어 있을 수 있어 버린다.
    throw new FrameError('json');
  }
  if (!isPlainObject(data)) throw new FrameError('body_shape');

  const list = data.frames;
  if (!Array.isArray(list)) throw new FrameError('frames_type');
  if (list.length < 1 || list.length > MAX_FRAMES) throw new FrameError('frame_count');

  let durationSec: number | null = null;
  if (data.durationSec !== undefined && data.durationSec !== null) {
    if (!isSeconds(data.durationSec) || data.durationSec <= 0) throw new FrameError('duration');
    durationSec = data.durationSec;
  }

  const frames: Frame[] = [];
  for (const item of list) {
    if (!isPlainObject(item)) throw new FrameError('frame_shape');
    if (!isSeconds(item.t)) throw new FrameError('frame_time');
    frames.push({ t: item.t, jpeg: checkJpeg(item.jpeg) });
  }
  frames.sort((a, b) => a.t - b.t);
  return { frames, durationSec };
}
