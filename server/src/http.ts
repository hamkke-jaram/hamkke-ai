// 요청 처리기(app.ts)를 node:http 서버에 잇는다. index.ts 가 띄우고, 테스트는 포트 0 으로 띄워 실제 소켓으로 확인한다.
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { App, AppResponse } from './app.ts';

/** 본문을 다 읽지 않고 응답한 연결을 닫기 전에 남은 본문을 흘려보내는 시간. */
const DRAIN_BEFORE_CLOSE_MS = 2_000;
/** 한꺼번에 받는 연결 수. 넘는 연결은 받지 않는다(연결마다 본문을 2MB 까지 모을 수 있다). */
const MAX_CONNECTIONS = 64;

export interface HttpOptions {
  drainMs?: number;
  maxConnections?: number;
}

function send(req: IncomingMessage, res: ServerResponse, response: AppResponse, drainMs: number): void {
  if (res.destroyed || res.writableEnded) return; // 요청한 쪽이 이미 끊음
  const body = Buffer.from(response.body, 'utf8');
  const headers: Record<string, string> = { ...response.headers, 'Content-Length': String(body.length) };
  const unread = !req.complete;
  if (unread) headers.Connection = 'close';
  res.writeHead(response.status, headers);
  res.end(body);
  if (unread) {
    // 거절한 요청의 남은 본문은 버리면서 잠깐 받아 주고(응답이 전해지도록), 그 뒤 연결을 닫는다.
    req.resume();
    setTimeout(() => req.destroy(), drainMs).unref();
  }
}

export function createHttpServer(app: App, options: HttpOptions = {}): Server {
  const drainMs = options.drainMs ?? DRAIN_BEFORE_CLOSE_MS;

  const server = createServer((req, res) => {
    // 응답을 다 쓰기 전에 연결이 닫히면 요청한 쪽이 끊은 것이다. 처리기가 모델 호출을 멈추게 알린다.
    const gone = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) gone.abort();
    });
    app
      .handle({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        // 중간에 읽기를 멈춰도 연결이 바로 끊기지 않게 한다(413 응답을 보낼 수 있어야 함).
        body: req.iterator({ destroyOnReturn: false }),
        signal: gone.signal,
      })
      .then(
        (response) => send(req, res, response, drainMs),
        () => {
          // handle 은 거절하지 않게 만들었지만, 만약을 위해 내용 없는 500 으로 끝낸다.
          if (res.destroyed || res.writableEnded) return;
          if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end('{"code":"INTERNAL_ERROR","message":"요청을 처리하지 못했어요."}');
        },
      );
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 64;
  server.maxConnections = options.maxConnections ?? MAX_CONNECTIONS;
  return server;
}
