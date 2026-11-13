import { describe, expect, it } from 'vitest';
import { createJtiStore } from '../src/jtiStore.ts';
import { QueueAbortedError, QueueFullError, createQueue } from '../src/queue.ts';

describe('대기열', () => {
  it('동시 처리 수만큼만 바로 자리를 준다', async () => {
    const queue = createQueue(2, 1);
    const a = await queue.acquire();
    await queue.acquire();
    expect(queue.active).toBe(2);
    let granted = false;
    const waiting = queue.acquire().then((release) => {
      granted = true;
      return release;
    });
    await Promise.resolve();
    expect(granted).toBe(false);
    expect(queue.waiting).toBe(1);
    a();
    const c = await waiting;
    expect(granted).toBe(true);
    expect(queue.active).toBe(2);
    expect(queue.waiting).toBe(0);
    c();
    expect(queue.active).toBe(1);
  });

  it('대기 자리가 다 차면 바로 거절한다', async () => {
    const queue = createQueue(1, 1);
    await queue.acquire();
    const waiting = queue.acquire();
    await expect(queue.acquire()).rejects.toBeInstanceOf(QueueFullError);
    expect(queue.waiting).toBe(1);
    waiting.catch(() => undefined);
  });

  it('대기 자리가 0 이면 처리 중일 때 모두 거절한다', async () => {
    const queue = createQueue(1, 0);
    const release = await queue.acquire();
    await expect(queue.acquire()).rejects.toBeInstanceOf(QueueFullError);
    release();
    await expect(queue.acquire()).resolves.toBeTypeOf('function');
  });

  it('먼저 기다린 순서대로 자리를 넘긴다', async () => {
    const queue = createQueue(1, 3);
    const order: string[] = [];
    const first = await queue.acquire();
    const b = queue.acquire().then((release) => {
      order.push('b');
      release();
    });
    const c = queue.acquire().then((release) => {
      order.push('c');
      release();
    });
    first();
    await Promise.all([b, c]);
    expect(order).toEqual(['b', 'c']);
    expect(queue.active).toBe(0);
  });

  it('자리를 두 번 내놓아도 한 번만 반영한다', async () => {
    const queue = createQueue(1, 1);
    const release = await queue.acquire();
    release();
    release();
    expect(queue.active).toBe(0);
  });

  it('기다리는 동안 신호가 중단되면 줄에서 빠진다', async () => {
    const queue = createQueue(1, 1);
    const release = await queue.acquire();
    const controller = new AbortController();
    const waiting = queue.acquire(controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(QueueAbortedError);
    expect(queue.waiting).toBe(0);
    release();
    expect(queue.active).toBe(0);
    await expect(queue.acquire(controller.signal)).rejects.toBeInstanceOf(QueueAbortedError);
  });
});

describe('jti 기억', () => {
  it('만료 전까지만 기억한다', () => {
    const store = createJtiStore();
    expect(store.add('a', 2_000, 1_000)).toBe(true);
    expect(store.has('a', 1_500)).toBe(true);
    expect(store.add('a', 2_000, 1_500)).toBe(false);
    expect(store.has('a', 2_000)).toBe(false);
    expect(store.size).toBe(0);
  });

  it('되돌린 jti 는 다시 쓸 수 있다', () => {
    const store = createJtiStore();
    store.add('a', 2_000, 1_000);
    store.delete('a');
    expect(store.has('a', 1_000)).toBe(false);
    expect(store.add('a', 2_000, 1_000)).toBe(true);
  });

  it('가득 차면 만료된 것을 치우고, 그래도 자리가 없으면 거절한다', () => {
    const store = createJtiStore(2);
    expect(store.add('a', 1_500, 1_000)).toBe(true);
    expect(store.add('b', 9_000, 1_000)).toBe(true);
    expect(store.add('c', 9_000, 1_100)).toBe(false);
    expect(store.add('c', 9_000, 1_600)).toBe(true);
    expect(store.size).toBe(2);
    expect(store.has('a', 1_600)).toBe(false);
  });
});
