import { describe, expect, it } from 'vitest';
import { LOW_MEMORY_MAX_FILE_BYTES, MAX_FILE_BYTES, MAX_SECONDS, MODEL_VERSION, fileTooLargeMessage, maxFileBytes } from './analyzeVideo';

describe('영상 파일 크기 상한', () => {
  it('기본 500MB, 메모리가 2GB 이하인 기기는 200MB', () => {
    expect(MAX_FILE_BYTES).toBe(500 * 1024 * 1024);
    expect(LOW_MEMORY_MAX_FILE_BYTES).toBe(200 * 1024 * 1024);
    expect(maxFileBytes()).toBe(MAX_FILE_BYTES);
    expect(maxFileBytes(8)).toBe(MAX_FILE_BYTES);
    expect(maxFileBytes(4)).toBe(MAX_FILE_BYTES);
    expect(maxFileBytes(2)).toBe(LOW_MEMORY_MAX_FILE_BYTES);
    expect(maxFileBytes(0.5)).toBe(LOW_MEMORY_MAX_FILE_BYTES);
    expect(maxFileBytes(0)).toBe(MAX_FILE_BYTES);
  });

  it('안내 문구는 실제 상한(MB)을 알려 주고 길이 제한(30분)과 어긋나는 말을 하지 않는다', () => {
    expect(fileTooLargeMessage(MAX_FILE_BYTES)).toBe(
      '영상 파일이 너무 커요. 500MB 이하 영상만 분석할 수 있어요. 1~3분 정도로 찍은 영상을 골라 주세요.',
    );
    expect(fileTooLargeMessage(LOW_MEMORY_MAX_FILE_BYTES)).toContain('200MB 이하');
    expect(fileTooLargeMessage(MAX_FILE_BYTES)).toMatch(/요\.$/);
    expect(MAX_SECONDS).toBe(1800);
  });

  it('계산 방법이 바뀌지 않았으니 모델 버전은 그대로다', () => {
    expect(MODEL_VERSION).toBe('pose_landmarker_lite@0.10.35+audio-heuristic-1');
  });
});
