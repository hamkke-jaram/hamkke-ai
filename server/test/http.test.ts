// http.ts 를 실제 소켓(포트 0)으로 띄워 확인한다. 모델은 가짜를 쓴다.
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_BODY_BYTES } from '../src/frames.ts';
import { createHttpServer } from '../src/http.ts';
import { fakeProvider, framesBody, sessionToken, testApp, untilAborted } from './helpers.ts';

let server: Server | null = null;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = null;
  }
});

async function listen(app: ReturnType<typeof testApp>['app']): Promise<number> {
  server = createHttpServer(app, { drainMs: 200 });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  return (server!.address() as AddressInfo).port;
}

interface Reply {
  status: number;
  body: Record<string, unknown>;
}

function post(port: number, body: Buffer, headers: Record<string, string>, signal?: AbortSignal): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: '127.0.0.1', port, method: 'POST', path: '/ai/v1/analyze', headers, signal },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

function jsonHeaders(token: string, length: number): Record<string, string> {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'content-length': String(length) };
}

describe('실제 소켓', () => {
  it('사진을 받아 관찰 기록과 영수증을 돌려준다', async () => {
    const { app } = testApp();
    const port = await listen(app);
    const body = Buffer.from(JSON.stringify(framesBody(3)), 'utf8');
    const reply = await post(port, body, jsonHeaders(sessionToken(), body.length));
    expect(reply.status).toBe(200);
    expect(typeof reply.body.receipt).toBe('string');
    expect(reply.body.analyzedFrames).toBe(3);
  });

  it('선언한 길이가 2MB 를 넘으면 본문을 다 받기 전에 413 으로 답한다', async () => {
    const { app, provider } = testApp();
    const port = await listen(app);
    const body = Buffer.alloc(MAX_BODY_BYTES + 1024, 0x20);
    const reply = await post(port, body, jsonHeaders(sessionToken(), body.length)).catch((err: Error) => err);
    // 서버가 응답 뒤 연결을 닫으므로 보내는 쪽에서 EPIPE·ECONNRESET 이 날 수도 있다. 응답을 받았다면 413 이어야 한다.
    if (!(reply instanceof Error)) {
      expect(reply.status).toBe(413);
      expect(reply.body.code).toBe('PAYLOAD_TOO_LARGE');
    }
    expect(provider.calls).toHaveLength(0);
  });

  it('요청한 쪽이 연결을 끊으면 모델 호출을 멈춘다', async () => {
    const provider = fakeProvider([untilAborted]);
    const { app, logs } = testApp({ provider, config: { timeoutMs: 30_000 } });
    const port = await listen(app);
    const body = Buffer.from(JSON.stringify(framesBody(2)), 'utf8');
    const client = new AbortController();
    const pending = post(port, body, jsonHeaders(sessionToken(), body.length), client.signal).catch(() => null);

    await waitFor(() => provider.calls.length === 1);
    client.abort();
    await pending;
    await waitFor(() => provider.calls[0]!.signal.aborted);
    expect(provider.calls[0]!.signal.aborted).toBe(true);
    await waitFor(() => logs.length > 0);
  });
});

async function waitFor(check: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
