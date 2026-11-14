// 새 환경 변수(대신 쓰는 모델, 모델 서버 인증·전송, 미리 올리기, 지표 토큰)와
// 환경 변수 목록이 문서·compose 와 맞는지.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ConfigError, isPrivateHost, loadConfig } from '../src/config.ts';

const REAL_SECRET = 'a-real-shared-secret-with-more-than-32-bytes!';
const PROD = { NODE_ENV: 'production', AI_SHARED_SECRET: REAL_SECRET };

const root = fileURLToPath(new URL('../../', import.meta.url));

describe('대신 쓰는 모델', () => {
  it('VL_FALLBACK_MODEL 만 주면 같은 Ollama 의 다른 모델을 쓴다', () => {
    const config = loadConfig({ OLLAMA_URL: 'http://ollama:11434', VL_FALLBACK_MODEL: 'qwen2.5vl:3b' });
    expect(config.fallbackModel).toBe('qwen2.5vl:3b');
    expect(config.fallbackUrl).toBe('http://ollama:11434');
  });

  it('VL_FALLBACK_URL 로 다른 서버를 가리킬 수 있다', () => {
    const config = loadConfig({ VL_FALLBACK_MODEL: 'qwen3.5:4b', VL_FALLBACK_URL: 'http://10.0.0.5:11434' });
    expect(config.fallbackUrl).toBe('http://10.0.0.5:11434');
  });

  it('모델 이름은 영수증 mv 로 나가므로 hamkke-api 가 받는 100자 이하, 공백 없는 이름만', () => {
    expect(loadConfig({ VL_MODEL: 'm'.repeat(100) }).model).toHaveLength(100);
    expect(() => loadConfig({ VL_MODEL: 'm'.repeat(101) })).toThrowError(ConfigError);
    expect(() => loadConfig({ VL_FALLBACK_MODEL: 'has space' })).toThrowError(ConfigError);
  });

  it('주소만 있거나, 같은 서버의 같은 모델이면 거절한다', () => {
    expect(() => loadConfig({ VL_FALLBACK_URL: 'http://ollama:11434' })).toThrowError(ConfigError);
    expect(() => loadConfig({ VL_FALLBACK_MODEL: 'qwen3.5:4b' })).toThrowError(ConfigError);
    expect(() => loadConfig({ VL_FALLBACK_MODEL: 'x', VL_FALLBACK_URL: 'ftp://host' })).toThrowError(ConfigError);
  });
});

describe('모델 서버 인증과 전송', () => {
  it('OLLAMA_AUTH_TOKEN 은 Bearer 로, OLLAMA_AUTH_HEADER 를 주면 그 헤더에 값 그대로 보낸다', () => {
    expect(loadConfig({ OLLAMA_AUTH_TOKEN: 'abc.def-123' }).ollamaAuth).toEqual({ name: 'Authorization', value: 'Bearer abc.def-123' });
    expect(loadConfig({ OLLAMA_AUTH_TOKEN: 'abc', OLLAMA_AUTH_HEADER: 'X-Api-Key' }).ollamaAuth).toEqual({ name: 'X-Api-Key', value: 'abc' });
  });

  it('헤더를 끼워 넣을 수 있는 값이나 짝이 없는 설정은 거절한다', () => {
    expect(() => loadConfig({ OLLAMA_AUTH_TOKEN: 'a\r\nX-Evil: 1' })).toThrowError(ConfigError);
    expect(() => loadConfig({ OLLAMA_AUTH_TOKEN: 'has space' })).toThrowError(ConfigError);
    expect(() => loadConfig({ OLLAMA_AUTH_TOKEN: 'abc', OLLAMA_AUTH_HEADER: 'Bad Header' })).toThrowError(ConfigError);
    expect(() => loadConfig({ OLLAMA_AUTH_HEADER: 'X-Api-Key' })).toThrowError(ConfigError);
    expect(() => loadConfig({ OLLAMA_URL: 'https://user:pw@ollama.example.kr' })).toThrowError(ConfigError);
  });

  it('바깥 주소를 http 로 가리키면 개발에서는 경고, production 에서는 거절(OLLAMA_ALLOW_INSECURE 로 풀 수 있다)', () => {
    const dev = loadConfig({ OLLAMA_URL: 'http://gpu.example.kr:11434' });
    expect(dev.warnings).toHaveLength(1);
    expect(dev.warnings[0]).toContain('OLLAMA_URL');
    expect(() => loadConfig({ ...PROD, OLLAMA_URL: 'http://gpu.example.kr:11434' })).toThrowError(ConfigError);
    expect(() => loadConfig({ ...PROD, OLLAMA_URL: 'http://203.0.113.7:11434' })).toThrowError(ConfigError);
    expect(() => loadConfig({ ...PROD, VL_FALLBACK_MODEL: 'x', VL_FALLBACK_URL: 'http://gpu.example.kr' })).toThrowError(ConfigError);
    const allowed = loadConfig({ ...PROD, OLLAMA_URL: 'http://gpu.example.kr:11434', OLLAMA_ALLOW_INSECURE: 'true' });
    expect(allowed.warnings).toHaveLength(1);
  });

  it('https 나 안쪽 주소는 경고 없이 쓴다', () => {
    for (const url of [
      'https://gpu.example.kr',
      'http://host.docker.internal:11434',
      'http://ollama:11434',
      'http://localhost:11434',
      'http://127.0.0.1:11434',
      'http://192.168.0.10:11434',
      'http://[::1]:11434',
    ]) {
      expect(loadConfig({ ...PROD, OLLAMA_URL: url }).warnings, url).toEqual([]);
    }
  });

  it('isPrivateHost', () => {
    for (const host of ['localhost', 'ollama', 'gpu.internal', 'nas.local', 'box.home.arpa', '10.1.2.3', '172.20.0.2', '100.100.1.1', 'fd12::1', 'fe80::1', '::ffff:192.168.1.1']) {
      expect(isPrivateHost(host), host).toBe(true);
    }
    for (const host of ['example.com', '8.8.8.8', '172.32.0.1', '2001:db8::1', '::ffff:8.8.8.8', 'internal.example.com']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});

describe('미리 올리기와 지표 토큰', () => {
  it('VL_WARMUP 은 true/false 로 받는다', () => {
    expect(loadConfig({ VL_WARMUP: 'true' }).warmup).toBe(true);
    expect(loadConfig({ VL_WARMUP: '1' }).warmup).toBe(true);
    expect(loadConfig({ VL_WARMUP: 'false' }).warmup).toBe(false);
    expect(loadConfig({ VL_WARMUP: '' }).warmup).toBe(false);
    expect(() => loadConfig({ VL_WARMUP: 'maybe' })).toThrowError(ConfigError);
  });

  it('METRICS_TOKEN 은 16자 이상이고 AI_SHARED_SECRET 과 달라야 한다', () => {
    expect(loadConfig({ METRICS_TOKEN: 'metrics-token-0123456789' }).metricsToken).toBe('metrics-token-0123456789');
    expect(() => loadConfig({ METRICS_TOKEN: 'short' })).toThrowError(ConfigError);
    expect(() => loadConfig({ METRICS_TOKEN: 'has space in the token value' })).toThrowError(ConfigError);
    expect(() => loadConfig({ AI_SHARED_SECRET: REAL_SECRET, METRICS_TOKEN: REAL_SECRET })).toThrowError(ConfigError);
  });
});

/** config.ts 가 읽는 환경 변수 이름. */
function configVariables(): string[] {
  const source = readFileSync(`${root}server/src/config.ts`, 'utf8');
  const names = new Set<string>();
  for (const match of source.matchAll(/(?:text|integer|flag|modelName)\(env, '([A-Z_]+)'/g)) names.add(match[1]!);
  for (const match of source.matchAll(/env\.([A-Z_]+)/g)) names.add(match[1]!);
  return [...names].sort();
}

describe('환경 변수 목록이 문서·compose 와 맞다', () => {
  it('config.ts 가 읽는 이름과 docs/observation.md 2장 표가 같다', () => {
    const doc = readFileSync(`${root}docs/observation.md`, 'utf8');
    const section = doc.slice(doc.indexOf('### 환경 변수'), doc.indexOf('## 3. API'));
    const documented = [...section.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]!).sort();
    const read = configVariables();
    expect(read.length).toBeGreaterThan(15);
    expect(documented).toEqual(read);
  });

  const compose = `${root}../hamkke-api/deploy/docker-compose.yml`;
  it.skipIf(!existsSync(compose))('hamkke-api compose 의 ai 서비스가 HOST 를 뺀 모든 이름을 넘긴다', () => {
    const text = readFileSync(compose, 'utf8');
    const aiService = text.slice(text.indexOf('\n  ai:'), text.indexOf('\n  web:'));
    const environment = aiService.slice(aiService.indexOf('environment:'), aiService.indexOf('extra_hosts:'));
    const missing = configVariables().filter((name) => name !== 'HOST' && !new RegExp(`^\\s+${name}:`, 'm').test(environment));
    expect(missing).toEqual([]);
  });
});
