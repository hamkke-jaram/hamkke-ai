import { describe, expect, it } from 'vitest';
import { ConfigError, DEV_SHARED_SECRET, loadConfig } from '../src/config.ts';
import { PROMPT_VERSION, buildPrompt, displayTime } from '../src/prompt.ts';

const REAL_SECRET = 'a-real-shared-secret-with-more-than-32-bytes!';

describe('환경 변수', () => {
  it('개발 기본값', () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      production: false,
      host: '127.0.0.1',
      port: 8090,
      usingDevSecret: true,
      ollamaUrl: 'http://localhost:11434',
      model: 'qwen3.5:4b',
      maxConcurrency: 1,
      maxWaiting: 2,
      timeoutMs: 180_000,
      maxWaitMs: 90_000,
      keepAlive: null,
    });
    expect(config.secret.toString('utf8')).toBe(DEV_SHARED_SECRET);
    expect(config.secret.length).toBeGreaterThanOrEqual(32);
  });

  it('값을 주면 그대로 쓴다', () => {
    const config = loadConfig({
      NODE_ENV: 'production',
      PORT: '9000',
      AI_SHARED_SECRET: REAL_SECRET,
      OLLAMA_URL: 'http://ollama:11434',
      VL_MODEL: 'other-vl:2b',
      VL_MAX_CONCURRENCY: '2',
      VL_MAX_WAITING: '0',
      VL_TIMEOUT_MS: '60000',
      VL_KEEP_ALIVE: '10m',
    });
    expect(config).toMatchObject({
      production: true,
      host: '0.0.0.0',
      port: 9000,
      usingDevSecret: false,
      ollamaUrl: 'http://ollama:11434',
      model: 'other-vl:2b',
      maxConcurrency: 2,
      maxWaiting: 0,
      timeoutMs: 60_000,
      maxWaitMs: 30_000,
      keepAlive: '10m',
    });
    expect(config.secret.equals(Buffer.from(REAL_SECRET, 'utf8'))).toBe(true);
  });

  it('차례를 기다리는 시간의 상한은 제한 시간의 절반이 기본이고, 제한 시간보다 길 수 없다', () => {
    expect(loadConfig({ VL_TIMEOUT_MS: '60000', VL_MAX_WAIT_MS: '45000' }).maxWaitMs).toBe(45_000);
    expect(loadConfig({ VL_MAX_WAIT_MS: '0' }).maxWaitMs).toBe(0);
    expect(() => loadConfig({ VL_TIMEOUT_MS: '60000', VL_MAX_WAIT_MS: '60001' })).toThrowError(ConfigError);
    expect(() => loadConfig({ VL_MAX_WAIT_MS: '1.5' })).toThrowError(ConfigError);
  });

  it('production 에서는 비밀이 꼭 있어야 하고 개발용 기본값은 쓸 수 없다', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrowError(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'production', AI_SHARED_SECRET: '  ' })).toThrowError(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'production', AI_SHARED_SECRET: DEV_SHARED_SECRET })).toThrowError(ConfigError);
  });

  it('32바이트보다 짧은 비밀을 거절한다', () => {
    expect(() => loadConfig({ AI_SHARED_SECRET: 'short-secret' })).toThrowError(ConfigError);
  });

  it('숫자가 아니거나 범위를 벗어난 값을 거절한다', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrowError(ConfigError);
    expect(() => loadConfig({ PORT: '70000' })).toThrowError(ConfigError);
    expect(() => loadConfig({ VL_MAX_CONCURRENCY: '0' })).toThrowError(ConfigError);
    expect(() => loadConfig({ VL_MAX_WAITING: '-1' })).toThrowError(ConfigError);
    expect(() => loadConfig({ VL_TIMEOUT_MS: '10' })).toThrowError(ConfigError);
    expect(() => loadConfig({ OLLAMA_URL: 'ollama' })).toThrowError(ConfigError);
    expect(() => loadConfig({ OLLAMA_URL: 'file:///etc/hosts' })).toThrowError(ConfigError);
  });
});

describe('프롬프트 obs-v1', () => {
  it('버전 이름', () => {
    expect(PROMPT_VERSION).toBe('obs-v1');
  });

  it('사진마다 시각을 알려 주고, 스키마의 t 는 그 시각만 허용한다', () => {
    const prompt = buildPrompt([0, 12.483, 25.04, 37.5], 50.2);
    expect(prompt.user).toContain('사진 4장');
    expect(prompt.user).toContain('- 사진 1: t=0\n- 사진 2: t=12.5\n- 사진 3: t=25\n- 사진 4: t=37.5');
    expect(prompt.user).toContain('약 50초');
    const schema = prompt.schema as {
      required: string[];
      properties: {
        moments: { maxItems: number; items: { properties: { t: { enum: number[] } } } };
        childStates: { maxItems: number; items: { enum: string[] } };
        adultResponses: { items: { enum: string[] } };
        peopleCount: { enum: number[] };
      };
    };
    expect(schema.properties.moments.items.properties.t.enum).toEqual([0, 12.5, 25, 37.5]);
    expect(schema.properties.moments.maxItems).toBe(4);
    expect(schema.properties.childStates.maxItems).toBe(3);
    expect(schema.properties.childStates.items.enum).toHaveLength(9);
    expect(schema.properties.adultResponses.items.enum).toHaveLength(6);
    expect(schema.properties.peopleCount.enum).toEqual([0, 1, 2, 3]);
    expect(schema.required).toEqual(['summary', 'childStates', 'adultResponses', 'moments', 'peopleCount']);
  });

  it('길이를 모르면 길이 문장을 빼고, 같은 시각은 한 번만 적는다', () => {
    const prompt = buildPrompt([3.01, 3.04], null);
    expect(prompt.user).not.toContain('전체 길이');
    const schema = prompt.schema as { properties: { moments: { items: { properties: { t: { enum: number[] } } } } } };
    expect(schema.properties.moments.items.properties.t.enum).toEqual([3]);
    expect(displayTime(12.449)).toBe(12.4);
  });

  it('지시문에 태그 열다섯 개와 그 뜻이 모두 들어 있다', () => {
    const { system } = buildPrompt([0], null);
    for (const line of ['- PLAYING_TOGETHER: 어른과 함께 놀아요', '- CALM: 차분해요', '- SETTING_LIMIT: 안 되는 것을 알려 줘요']) {
      expect(system).toContain(line);
    }
    expect(system.match(/^- [A-Z_]+: /gm)).toHaveLength(15);
    expect(system).toContain('화면에 아이가 보이지 않아요.');
  });
});
