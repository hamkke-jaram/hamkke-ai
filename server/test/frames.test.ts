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
  withoutMetadata,
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

describe('메타데이터 빼기 (EXIF 위치 등)', () => {
  /** SOI 바로 뒤에 구획 하나를 끼운다. */
  function withSegment(jpeg: Buffer, marker: number, payload: Buffer): Buffer {
    const head = Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]);
    return Buffer.concat([jpeg.subarray(0, 2), head, payload, jpeg.subarray(2)]);
  }
  /** SOI·APP0·SOF0·SOS·그림 자료·EOI 를 갖춘 작은 JPEG(진짜 파일과 같은 구획 순서). */
  function jpegWithScan(): Buffer {
    const head = makeJpeg().subarray(0, 33); // SOI + APP0 + SOF0
    const sos = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
    return Buffer.concat([head, sos, Buffer.alloc(64, 0x5a), Buffer.from([0xff, 0xd9])]);
  }
  const exif = Buffer.concat([Buffer.from('Exif', 'latin1'), Buffer.alloc(2), Buffer.from('II*', 'latin1'), Buffer.alloc(40, 7)]);

  it('APP1(EXIF)·APP13·주석을 빼고 나머지 바이트는 그대로 둔다', () => {
    const plain = jpegWithScan();
    const tagged = withSegment(withSegment(withSegment(plain, 0xe1, exif), 0xed, Buffer.alloc(12, 1)), 0xfe, Buffer.from('comment', 'latin1'));
    const cleaned = withoutMetadata(tagged)!;
    expect(cleaned.equals(plain)).toBe(true);
    expect(readJpegSize(cleaned)).toEqual(readJpegSize(plain));
  });

  it('뺄 것이 없거나 구조가 어긋나면 null(원본을 그대로 쓴다)', () => {
    expect(withoutMetadata(jpegWithScan())).toBeNull();
    expect(withoutMetadata(withSegment(makeJpeg(), 0xe1, exif))).toBeNull(); // SOS 없이 끝나는 이상한 파일
    expect(withoutMetadata(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x40, 0x00, 1, 2]))).toBeNull(); // 길이가 파일보다 김
    expect(withoutMetadata(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });

  it('검사를 지난 사진에서 메타데이터가 빠진 채로 모델에 넘어간다', () => {
    const tagged = withSegment(jpegWithScan(), 0xe1, exif);
    const { frames } = parseOf({ frames: [frame(0, tagged)] });
    const sent = Buffer.from(frames[0]!.jpeg, 'base64');
    expect(sent.includes(Buffer.from('Exif', 'latin1'))).toBe(false);
    expect(sent.equals(jpegWithScan())).toBe(true);
  });

  it('메타데이터가 없는 사진은 보낸 문자열 그대로다', () => {
    const plain = frame(0);
    expect(parseOf({ frames: [plain] }).frames[0]!.jpeg).toBe(plain.jpeg);
  });
});
