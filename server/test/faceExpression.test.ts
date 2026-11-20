import { expect, it, vi } from 'vitest';
import { verifyFacePhoto } from '../src/faceExpression.ts';
import type { VisionProvider, VisionRequest } from '../src/provider.ts';

function provider(generate: VisionProvider['generate']): VisionProvider {
  return { modelVersion: 'test', generate, isReady: async () => true };
}

it('아이와 어른의 입 모양을 한 장에서 각각 확인한다', async () => {
  const generate = vi.fn(async (_request:VisionRequest) => ({ text:'{"child":"OPEN_MOUTH","adult":"SMILE"}', modelVersion:'test' }));
  const signal = new AbortController().signal;
  await expect(verifyFacePhoto(provider(generate),'one-frame',signal)).resolves.toEqual({ child:'OPEN_MOUTH', adult:'SMILE' });
  expect(generate).toHaveBeenCalledTimes(1);
  const [{ images, schema, signal: received }] = generate.mock.calls[0]!;
  expect(images).toEqual(['one-frame']);
  expect(schema).toMatchObject({ additionalProperties:false, required:['child','adult'] });
  expect(received.aborted).toBe(false);
});

it('가려진 역할이 다른 사람의 보이는 입 모양을 덮지 않는다', async () => {
  const model = provider(async () => '{"adult":"UNCLEAR","child":"NOT_SMILING"}');
  await expect(verifyFacePhoto(model,'one-frame',new AbortController().signal))
    .resolves.toEqual({ child:'NOT_SMILING', adult:'UNCLEAR' });
});

it.each([
  'not-json', '{"child":"LAUGHING","adult":"SMILE"}', '{"child":"SMILE"}',
  '{"child":"SMILE","adult":"UNCLEAR","noise":"laughter"}', '["SMILE","UNCLEAR"]',
])('검증되지 않은 응답을 사용하지 않는다: %s', async reply => {
  await expect(verifyFacePhoto(provider(async () => reply),'one-frame',new AbortController().signal)).resolves.toBeNull();
});

it('보조 점검만 실패하면 판단을 보류한다', async () => {
  const model = provider(async () => { throw new Error('model unavailable'); });
  await expect(verifyFacePhoto(model,'one-frame',new AbortController().signal)).resolves.toBeNull();
});

it('최대 점검 시간이 지나면 전체 요청을 취소하지 않고 판단을 보류한다', async () => {
  const timeout = new AbortController();
  const limit = vi.spyOn(AbortSignal,'timeout').mockReturnValue(timeout.signal);
  try {
    const outer = new AbortController();
    const model = provider(async () => new Promise<string>(() => { /* never resolves */ }));
    const checked = verifyFacePhoto(model,'one-frame',outer.signal);
    await Promise.resolve();
    timeout.abort();
    await expect(checked).resolves.toBeNull();
    expect(limit).toHaveBeenCalledWith(10_000);
    expect(outer.signal.aborted).toBe(false);
  } finally {
    limit.mockRestore();
  }
});

it('요청이 취소되면 제공자가 아직 답하지 않았더라도 멈춘다', async () => {
  const controller = new AbortController();
  const reason = new Error('request ended');
  const generate = vi.fn(async (_request:VisionRequest) => new Promise<string>(() => { /* never resolves */ }));
  const checked = verifyFacePhoto(provider(generate),'one-frame',controller.signal);
  await Promise.resolve();
  controller.abort(reason);
  await expect(checked).rejects.toBe(reason);
  expect(generate.mock.calls[0]?.[0].signal.aborted).toBe(true);
  await expect(verifyFacePhoto(provider(generate),'one-frame',controller.signal)).rejects.toBe(reason);
  expect(generate).toHaveBeenCalledTimes(1);
});
