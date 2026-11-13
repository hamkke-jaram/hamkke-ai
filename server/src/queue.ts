// 동시 처리 수 제한과 길이가 정해진 대기열. 자리가 없으면 바로 거절한다(→ 429 BUSY).

export class QueueFullError extends Error {
  constructor() {
    super('queue full');
    this.name = 'QueueFullError';
  }
}

/** 기다리는 동안 신호가 중단되었을 때. */
export class QueueAbortedError extends Error {
  constructor() {
    super('aborted while waiting');
    this.name = 'QueueAbortedError';
  }
}

export interface WorkQueue {
  /**
   * 처리할 자리를 얻는다. 돌려받은 함수를 불러 자리를 내놓는다(여러 번 불러도 한 번만 반영).
   * 대기열이 가득 찼으면 QueueFullError, 기다리다 신호가 중단되면 QueueAbortedError 로 거절한다.
   * 가득 찼는지는 부른 순간에 정해진다.
   */
  acquire(signal?: AbortSignal): Promise<() => void>;
  readonly active: number;
  readonly waiting: number;
}

interface Waiter {
  grant: () => void;
}

export function createQueue(maxConcurrency: number, maxWaiting: number): WorkQueue {
  let active = 0;
  const waiters: Waiter[] = [];

  function releaser(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next) next.grant(); // 자리를 그대로 넘겨준다
      else active--;
    };
  }

  function acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new QueueAbortedError());
    if (active < maxConcurrency) {
      active++;
      return Promise.resolve(releaser());
    }
    if (waiters.length >= maxWaiting) return Promise.reject(new QueueFullError());
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(releaser());
        },
      };
      function onAbort(): void {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
        reject(new QueueAbortedError());
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.push(waiter);
    });
  }

  return {
    acquire,
    get active() {
      return active;
    },
    get waiting() {
      return waiters.length;
    },
  };
}
