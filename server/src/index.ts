// AI 서버 시작점. 실행: node server/src/index.ts (Node 24, 타입은 실행할 때 지워진다)
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { createHttpServer } from './http.ts';
import { createOllamaProvider } from './ollama.ts';

const SHUTDOWN_GRACE_MS = 10_000;

function note(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra })}\n`;
  (level === 'info' ? process.stdout : process.stderr).write(line);
}

function start(config: Config): void {
  const provider = createOllamaProvider({
    baseUrl: config.ollamaUrl,
    model: config.model,
    keepAlive: config.keepAlive,
    numCtx: config.numCtx,
    maxOutputTokens: config.maxOutputTokens,
  });
  const app = createApp({ config, provider });

  const server = createHttpServer(app);

  server.on('error', (err) => {
    note('error', 'server_error', { name: err.name, code: (err as NodeJS.ErrnoException).code });
    process.exit(1);
  });
  server.listen(config.port, config.host, () => {
    note('info', 'listening', {
      host: config.host,
      port: config.port,
      model: config.model,
      maxConcurrency: config.maxConcurrency,
      maxWaiting: config.maxWaiting,
      timeoutMs: config.timeoutMs,
      maxWaitMs: config.maxWaitMs,
    });
  });

  let stopping = false;
  function stop(signalName: string): void {
    if (stopping) return;
    stopping = true;
    note('info', 'stopping', { signal: signalName });
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
  }
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

try {
  const config = loadConfig(process.env);
  if (config.usingDevSecret) {
    note('warn', 'AI_SHARED_SECRET 이 없어 개발용 기본값을 쓰고 있어요. 배포할 때는 꼭 따로 정해 주세요.');
  }
  start(config);
} catch (err) {
  if (err instanceof ConfigError) {
    note('error', err.message);
    process.exit(1);
  }
  throw err;
}
