// AI 서버 시작점. 실행: node server/src/index.ts (Node 24, 타입은 실행할 때 지워진다)
import { createApp } from './app.ts';
import { ConfigError, loadConfig } from './config.ts';
import type { Config } from './config.ts';
import { createHttpServer } from './http.ts';
import { ProviderUnavailableError } from './provider.ts';
import type { VisionProvider } from './provider.ts';
import { createProviderFromConfig } from './providers.ts';

const SHUTDOWN_GRACE_MS = 10_000;

function note(level: 'info' | 'warn' | 'error', msg: string, extra: Record<string, unknown> = {}): void {
  const line = `${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra })}\n`;
  (level === 'info' ? process.stdout : process.stderr).write(line);
}

/** 모델을 미리 메모리에 올린다. 기다리지 않는다: 실패해도 서버는 그대로 받고, 첫 요청이 모델을 불러온다. */
function warmUp(provider: VisionProvider, config: Config): void {
  if (!config.warmup || !provider.warmUp) return;
  const started = Date.now();
  provider.warmUp(AbortSignal.timeout(config.timeoutMs)).then(
    () => note('info', 'warmup_done', { model: config.model, ms: Date.now() - started }),
    (err: unknown) =>
      note('warn', 'warmup_failed', {
        model: config.model,
        ms: Date.now() - started,
        detail: err instanceof ProviderUnavailableError ? err.detail : err instanceof Error ? err.name : 'unknown',
      }),
  );
}

function start(config: Config): void {
  const provider = createProviderFromConfig(config, {
    // 사진·문장 없이 첫 모델이 실패한 짧은 코드만 남긴다.
    onFallback: (detail) => note('warn', 'fallback_model_used', { model: config.fallbackModel, detail }),
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
      fallbackModel: config.fallbackModel,
      maxConcurrency: config.maxConcurrency,
      maxWaiting: config.maxWaiting,
      timeoutMs: config.timeoutMs,
      maxWaitMs: config.maxWaitMs,
      warmup: config.warmup,
      modelServerAuth: config.ollamaAuth !== null, // 값은 남기지 않는다
      metricsProtected: config.metricsToken !== null,
    });
    warmUp(provider, config);
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
  for (const warning of config.warnings) note('warn', warning);
  start(config);
} catch (err) {
  if (err instanceof ConfigError) {
    note('error', err.message);
    process.exit(1);
  }
  throw err;
}
