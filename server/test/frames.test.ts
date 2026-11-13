import { describe, expect, it } from 'vitest';
import {
  BodyTooLargeError,
  FrameError,
  MAX_BODY_BYTES,
  MAX_FRAME_BYTES,
  jsonDepthWithin,
  parseAnalyzeBody,
  readBody,
  readJpegSize,
} from '../src/frames.ts';
import { chunked, frame, framesBody, makeJpeg } from './helpers.ts';

function parseOf(body: unknown): ReturnType<typeof parseAnalyzeBody> {
  return parseAnalyzeBody(Buffer.from(JSON.stringify(body), 'utf8'));
}

function reasonOf(body: unknown): string {
  try {
    parseOf(body);
  } catch (err) {
    if (err instanceof FrameError) return err.reason;
    throw err;
  }
  return 'accepted';
}

describe('본문 읽기', () => {
  it('상한 안쪽 본문을 그대로 모은다', async () => {
    const bytes = Buffer.from('{"frames":[]}', 'utf8');
    const read = await readBody(chunked(Buffer.from(bytes), 4), 100);
    expect(read.toString('utf8')).toBe('{"frames":[]}');
  });

  it('상한을 넘는 순간 읽기를 멈춘다', async () => {
    let yielded = 0;
    async function* endless(): AsyncGenerator<Uint8Array> {
      for (;;) {
        yielded++;
        yield new Uint8Array(64 * 1024);
      }
    }
    await expect(readBody(endless(), MAX_BODY_BYTES)).rejects.toBeInstanceOf(BodyTooLargeError);
    expect(yielded).toBe(MAX_BODY_BYTES / (64 * 1024) + 1);
  });

  it('딱 상한만큼은 받아들인다', async () => {
    const read = await readBody(chunked(new Uint8Array(1000)), 1000);
    expect(read.length).toBe(1000);
  });
});

describe('JPEG 확인', () => {
  it('머리 부분에서 가로·세로를 읽는다', () => {
    expect(readJpegSize(makeJpeg({ width: 512, height: 384 }))).toEqual({ width: 512, height: 384 });
  });

  it('시작 바이트가 FF D8 FF 가 아니면 JPEG 로 보지 않는다', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(readJpegSize(png)).toBeNull();
    expect(readJpegSize(Buffer.from([0xff, 0xd8]))).toBeNull();
  });

  it('크기 정보 없이 끝나거나 길이가 어긋나면 받아들이지 않는다', () => {
    expect(readJpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0, 0]))).toBeNull();
    expect(readJpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff, 0, 0]))).toBeNull();
    expect(readJpegSize(Buffer.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02, 0, 0]))).toBeNull();
  });
});

describe('JSON 깊이', () => {
  it('문자열 안의 괄호는 세지 않는다', () => {
    expect(jsonDepthWithin('{"a":"[[[[[[[[[[","b":"\\"{{{{{{"}', 2)).toBe(true);
    expect(jsonDepthWithin('[[[[1]]]]', 3)).toBe(false);
    expect(jsonDepthWithin('[[[1]]]', 3)).toBe(true);
  });
});

describe('분석 요청 본문 검사', () => {
  it('사진을 시각 순서로 돌려준다', () => {
    const input = parseOf({ frames: [frame(20), frame(0), frame(10.5)], durationSec: 30 });
    expect(input.frames.map((f) => f.t)).toEqual([0, 10.5, 20]);
    expect(input.durationSec).toBe(30);
    expect(input.frames[0]!.jpeg).toBe(makeJpeg().toString('base64'));
  });

  it('durationSec 은 없어도 된다', () => {
    expect(parseOf({ frames: [frame(0)] }).durationSec).toBeNull();
  });

  it('넘겨받은 본문 바이트를 0으로 덮는다', () => {
    const raw = Buffer.from(JSON.stringify(framesBody(1)), 'utf8');
    parseAnalyzeBody(raw);
    expect(raw.every((b) => b === 0)).toBe(true);
  });

  it('사진이 없거나 6장을 넘으면 거절한다', () => {
    expect(reasonOf({ frames: [] })).toBe('frame_count');
    expect(reasonOf(framesBody(6))).toBe('accepted');
    expect(reasonOf(framesBody(7))).toBe('frame_count');
    expect(reasonOf({})).toBe('frames_type');
    expect(reasonOf({ frames: 'x' })).toBe('frames_type');
    expect(reasonOf([frame(0)])).toBe('body_shape');
  });

  it('JPEG 가 아닌 사진을 거절한다', () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
    expect(reasonOf({ frames: [frame(0, png)] })).toBe('not_jpeg');
    expect(reasonOf({ frames: [frame(0, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))] })).toBe('not_jpeg');
  });

  it('300KB 를 넘는 사진을 거절하고, 딱 300KB 는 받아들인다', () => {
    expect(reasonOf({ frames: [frame(0, makeJpeg({ size: MAX_FRAME_BYTES }))] })).toBe('accepted');
    expect(reasonOf({ frames: [frame(0, makeJpeg({ size: MAX_FRAME_BYTES + 1 }))] })).toBe('frame_too_large');
  });

  it('base64 가 아닌 글자를 거절한다', () => {
    const good = makeJpeg().toString('base64');
    expect(reasonOf({ frames: [{ t: 0, jpeg: `data:image/jpeg;base64,${good}` }] })).toBe('base64');
    expect(reasonOf({ frames: [{ t: 0, jpeg: `${good.slice(0, -4)}*a==` }] })).toBe('base64');
    expect(reasonOf({ frames: [{ t: 0, jpeg: good.slice(0, -1) }] })).toBe('base64');
    expect(reasonOf({ frames: [{ t: 0, jpeg: '' }] })).toBe('base64');
    expect(reasonOf({ frames: [{ t: 0, jpeg: 12 }] })).toBe('jpeg_type');
    expect(reasonOf({ frames: [{ t: 0 }] })).toBe('jpeg_type');
  });

  it('지나치게 크거나 작은 그림 크기를 거절한다', () => {
    expect(reasonOf({ frames: [frame(0, makeJpeg({ width: 2048, height: 1536 }))] })).toBe('accepted');
    expect(reasonOf({ frames: [frame(0, makeJpeg({ width: 65000, height: 65000 }))] })).toBe('frame_dimensions');
    expect(reasonOf({ frames: [frame(0, makeJpeg({ width: 512, height: 8 }))] })).toBe('frame_dimensions');
  });

  it('시각과 길이는 0 이상의 수여야 한다', () => {
    expect(reasonOf({ frames: [{ ...frame(0), t: -1 }] })).toBe('frame_time');
    expect(reasonOf({ frames: [{ ...frame(0), t: '3' }] })).toBe('frame_time');
    expect(reasonOf({ frames: [{ jpeg: frame(0).jpeg }] })).toBe('frame_time');
    expect(reasonOf({ frames: [frame(0)], durationSec: 0 })).toBe('duration');
    expect(reasonOf({ frames: [frame(0)], durationSec: 'long' })).toBe('duration');
    expect(reasonOf({ frames: ['x'] })).toBe('frame_shape');
  });

  it('JSON 이 아니거나 너무 깊으면 거절한다', () => {
    const rejects = (text: string): string => {
      try {
        parseAnalyzeBody(Buffer.from(text, 'utf8'));
      } catch (err) {
        if (err instanceof FrameError) return err.reason;
        throw err;
      }
      return 'accepted';
    };
    expect(rejects('{"frames":')).toBe('json');
    expect(rejects('')).toBe('json');
    expect(rejects(`{"frames":${'['.repeat(50)}${']'.repeat(50)}}`)).toBe('json_depth');
    expect(() => parseAnalyzeBody(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))).toThrowError(FrameError);
  });

  it('오류에 본문 내용을 담지 않는다', () => {
    const secretText = 'c2VjcmV0LWltYWdlLWJ5dGVz';
    try {
      parseAnalyzeBody(Buffer.from(`{"frames":[{"t":0,"jpeg":"${secretText}"},]}`, 'utf8'));
      expect.unreachable();
    } catch (err) {
      expect(String(err)).not.toContain(secretText);
      expect((err as Error).message).toBe('frames rejected');
    }
  });
});
