import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { RECEIPT_TTL_SEC, TokenError, signJwt, signReceipt, verifyJwt, verifySessionToken } from '../src/jwt.ts';
import { NOW_SEC, OTHER_SECRET, SECRET, sessionPayload, sessionToken } from './helpers.ts';

function segment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    if (err instanceof TokenError) return err.reason;
    throw err;
  }
  return 'accepted';
}

describe('HS256 서명·검증', () => {
  it('직접 계산한 HMAC-SHA256 과 같은 서명을 만든다', () => {
    const token = signJwt({ a: 1 }, SECRET);
    const [header, payload, signature] = token.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ alg: 'HS256', typ: 'JWT' });
    const expected = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
    expect(signature).toBe(expected);
    expect(verifyJwt(token, SECRET)).toEqual({ a: 1 });
  });

  it('다른 비밀로 서명한 토큰을 거절한다', () => {
    expect(reasonOf(() => verifyJwt(signJwt({ a: 1 }, OTHER_SECRET), SECRET))).toBe('signature');
  });

  it('내용을 바꾼 토큰을 거절한다', () => {
    const [header, , signature] = signJwt({ cid: 7 }, SECRET).split('.');
    expect(reasonOf(() => verifyJwt(`${header}.${segment({ cid: 8 })}.${signature}`, SECRET))).toBe('signature');
  });

  it('alg 가 none 이면 서명이 없어도, 있어도 거절한다', () => {
    const body = segment(sessionPayload());
    const none = segment({ alg: 'none', typ: 'JWT' });
    expect(reasonOf(() => verifyJwt(`${none}.${body}.`, SECRET))).toBe('alg');
    const signature = createHmac('sha256', SECRET).update(`${none}.${body}`).digest('base64url');
    expect(reasonOf(() => verifyJwt(`${none}.${body}.${signature}`, SECRET))).toBe('alg');
  });

  it('HS256 이 아닌 알고리즘 이름을 거절한다', () => {
    for (const alg of ['HS512', 'RS256', 'hs256', undefined]) {
      const head = segment({ alg, typ: 'JWT' });
      const body = segment({ a: 1 });
      const signature = createHmac('sha256', SECRET).update(`${head}.${body}`).digest('base64url');
      expect(reasonOf(() => verifyJwt(`${head}.${body}.${signature}`, SECRET))).toBe('alg');
    }
  });

  it('형식이 어긋난 토큰을 거절한다', () => {
    expect(reasonOf(() => verifyJwt('', SECRET))).toBe('length');
    expect(reasonOf(() => verifyJwt('a.b', SECRET))).toBe('format');
    expect(reasonOf(() => verifyJwt('a.b.c.d', SECRET))).toBe('format');
    expect(reasonOf(() => verifyJwt('!!.e30.e30', SECRET))).toBe('header');
    expect(reasonOf(() => verifyJwt(`${'a'.repeat(5000)}.b.c`, SECRET))).toBe('length');
  });
});

describe('분석 토큰 검증', () => {
  const verify = (overrides: Record<string, unknown>, secret = SECRET) =>
    reasonOf(() => verifySessionToken(sessionToken(overrides, secret), SECRET, NOW_SEC));

  it('올바른 토큰의 클레임을 돌려준다', () => {
    const claims = verifySessionToken(sessionToken({ jti: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', src: 'INSTITUTION' }), SECRET, NOW_SEC);
    expect(claims).toEqual({
      sub: '42',
      cid: 7,
      src: 'INSTITUTION',
      jti: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      iat: NOW_SEC - 5,
      exp: NOW_SEC + 600,
    });
  });

  it('aud 가 배열이어도 hamkke-ai 가 들어 있으면 받아들인다', () => {
    expect(verify({ aud: ['hamkke-ai'] })).toBe('accepted');
  });

  it('발급자·대상이 다르면 거절한다', () => {
    expect(verify({ iss: 'someone-else' })).toBe('iss');
    expect(verify({ aud: 'hamkke-api' })).toBe('aud');
    expect(verify({ aud: ['hamkke-web'] })).toBe('aud');
    expect(verify({ aud: undefined })).toBe('aud');
  });

  it('만료된 토큰을 거절한다', () => {
    expect(verify({ exp: NOW_SEC })).toBe('expired');
    expect(verify({ exp: NOW_SEC - 1 })).toBe('expired');
    expect(verify({ exp: undefined })).toBe('exp');
    expect(verify({ exp: 'soon' })).toBe('exp');
  });

  it('발급 시각이 한참 앞선 토큰을 거절한다', () => {
    expect(verify({ iat: NOW_SEC + 3600, exp: NOW_SEC + 7200 })).toBe('iat');
    expect(verify({ iat: undefined })).toBe('iat');
  });

  it('필수 클레임이 없거나 형식이 다르면 거절한다', () => {
    expect(verify({ sub: undefined })).toBe('sub');
    expect(verify({ sub: 42 })).toBe('sub');
    expect(verify({ cid: undefined })).toBe('cid');
    expect(verify({ cid: '7' })).toBe('cid');
    expect(verify({ cid: 0 })).toBe('cid');
    expect(verify({ src: 'OTHER' })).toBe('src');
    expect(verify({ jti: undefined })).toBe('jti');
    expect(verify({ jti: 'x y' })).toBe('jti');
  });

  it('다른 비밀로 만든 토큰을 거절한다', () => {
    expect(verify({}, OTHER_SECRET)).toBe('signature');
  });
});

describe('영수증', () => {
  it('분석 토큰의 값을 옮기고 15분 동안 유효하다', () => {
    const session = verifySessionToken(sessionToken({ src: 'INSTITUTION' }), SECRET, NOW_SEC);
    const obs = { summary: null, childStates: ['CALM'], adultResponses: [], moments: [], peopleCount: 1 };
    const receipt = signReceipt(
      { session, obs, modelVersion: 'fake-vl:1', promptVersion: 'obs-v1', frameCount: 4 },
      SECRET,
      NOW_SEC + 30,
    );
    expect(verifyJwt(receipt, SECRET)).toEqual({
      iss: 'hamkke-ai',
      aud: 'hamkke-api',
      sub: session.sub,
      cid: session.cid,
      src: 'INSTITUTION',
      jti: session.jti,
      obs,
      mv: 'fake-vl:1',
      pv: 'obs-v1',
      fc: 4,
      iat: NOW_SEC + 30,
      exp: NOW_SEC + 30 + RECEIPT_TTL_SEC,
    });
    expect(RECEIPT_TTL_SEC).toBe(900);
  });

  it('영수증은 분석 토큰으로 쓸 수 없다', () => {
    const session = verifySessionToken(sessionToken(), SECRET, NOW_SEC);
    const receipt = signReceipt({ session, obs: {}, modelVersion: 'm', promptVersion: 'p', frameCount: 1 }, SECRET, NOW_SEC);
    expect(reasonOf(() => verifySessionToken(receipt, SECRET, NOW_SEC))).toBe('iss');
  });
});
