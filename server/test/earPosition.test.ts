import { expect, it, vi } from 'vitest';
import { verifyEarPhoto } from '../src/earPosition.ts';
import type { VisionProvider, VisionRequest } from '../src/provider.ts';

function provider(generate: VisionProvider['generate']): VisionProvider {
  return { modelVersion: 'test', generate, isReady: async () => true };
}

it.each(['COVERING', 'TOUCHING', 'HANDS_RAISED', 'NO_COVER', 'UNCLEAR'] as const)('한 장에서 판정한 입증 수준을 그대로 반환한다: %s', async position => {
  const generate = vi.fn(async (request: VisionRequest) => ({
    text: JSON.stringify(request.system.startsWith('Check spatial contact')
      ? {left:'OVER_EAR',right:'UNCLEAR'} : {position}), modelVersion: 'test',
  }));
  await expect(verifyEarPhoto(provider(generate),'frame',new AbortController().signal)).resolves.toBe(position);
  expect(generate).toHaveBeenCalledTimes(position === 'COVERING' ? 2 : 1);
  const [{ images, schema }] = generate.mock.calls[0]!;
  expect(images).toEqual(['frame']);
  expect(schema).toMatchObject({ additionalProperties: false, required: ['position'] });
});

it('손과 귀 사이의 간격을 확인하면 첫 가림 분류를 보류한다', async () => {
  const generate = vi.fn(async (request: VisionRequest) => request.system.startsWith('Check spatial contact')
    ? '{"left":"VISIBLE_GAP_OR_OTHER_LOCATION","right":"UNCLEAR"}' : '{"position":"COVERING"}');
  await expect(verifyEarPhoto(provider(generate),'frame',new AbortController().signal)).resolves.toBe('UNCLEAR');
  expect(generate.mock.calls.map(([request])=>request.images)).toEqual([['frame'],['frame']]);
});

it.each(['invalid json', '["COVERING"]', '{"position":"NEAR_EARS"}', '{"position":"COVERING","extra":true}'])('계약 밖 판정을 사용하지 않는다: %s', async reply => {
  await expect(verifyEarPhoto(provider(async () => reply),'frame',new AbortController().signal)).resolves.toBeNull();
});

it('오류나 단일 사진 점검의 제한 시간은 판정 보류로 처리한다', async () => {
  const controller = new AbortController();
  const timeout = new AbortController();
  const limit = vi.spyOn(AbortSignal,'timeout').mockReturnValue(timeout.signal);
  try {
    await expect(verifyEarPhoto(provider(async () => { throw new Error('unavailable'); }),'frame',controller.signal)).resolves.toBeNull();
    const model = provider(async () => new Promise<string>(() => { /* never resolves */ }));
    const checked = verifyEarPhoto(model,'frame',controller.signal);
    await Promise.resolve();
    timeout.abort();
    await expect(checked).resolves.toBeNull();
    expect(limit).toHaveBeenCalledWith(10_000);
    expect(controller.signal.aborted).toBe(false);
  } finally {
    limit.mockRestore();
  }
});

it('전체 요청 취소는 모델이 응답하지 않아도 즉시 전달한다', async () => {
  const controller = new AbortController();
  const reason = new Error('request stopped');
  const generate = vi.fn(async (_request: VisionRequest) => new Promise<string>(() => { /* never resolves */ }));
  const checked = verifyEarPhoto(provider(generate),'frame',controller.signal);
  await Promise.resolve();
  controller.abort(reason);
  await expect(checked).rejects.toBe(reason);
  expect(generate.mock.calls[0]?.[0].signal.aborted).toBe(true);
  await expect(verifyEarPhoto(provider(generate),'frame',controller.signal)).rejects.toBe(reason);
  expect(generate).toHaveBeenCalledTimes(1);
});
