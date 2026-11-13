// HS256 JWT 서명·검증 (hamkke-api docs/ai-observation.md 4장).
// 외부 라이브러리 없이 node:crypto 만 쓴다. 허용하는 알고리즘은 HS256 하나뿐이다.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SESSION_ISSUER = 'hamkke-api';
export const SESSION_AUDIENCE = 'hamkke-ai';
export const RECEIPT_ISSUER = 'hamkke-ai';
export const RECEIPT_AUDIENCE = 'hamkke-api';
export const RECEIPT_TTL_SEC = 15 * 60;

/** 토큰 문자열 길이 상한. 분석 토큰은 수백 자 수준이다. */
const MAX_TOKEN_LENGTH = 4096;
/** 발급 시각이 이 서버 시계보다 앞설 수 있는 여유(초). */
const CLOCK_SKEW_SEC = 60;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const JTI_FORMAT = /^[A-Za-z0-9_-]{8,64}$/;

export type CaptureSource = 'HOME' | 'INSTITUTION';

export interface SessionClaims {
  sub: string;
  cid: number;
  src: CaptureSource;
  jti: string;
  iat: number;
  exp: number;
}

/** 토큰을 받아들일 수 없는 까닭. 로그에만 남기고 응답에는 넣지 않는다. */
export class TokenError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super('token rejected');
    this.name = 'TokenError';
    this.reason = reason;
  }
}

function encodeSegment(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeSegment(segment: string, reason: string): Record<string, unknown> {
  if (!BASE64URL.test(segment)) throw new TokenError(reason);
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
  } catch {
    throw new TokenError(reason);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TokenError(reason);
  return value as Record<string, unknown>;
}

function hmac(input: string, secret: Buffer): Buffer {
  return createHmac('sha256', secret).update(input, 'utf8').digest();
}

export function signJwt(payload: Record<string, unknown>, secret: Buffer): string {
  const signingInput = `${encodeSegment({ alg: 'HS256', typ: 'JWT' })}.${encodeSegment(payload)}`;
  return `${signingInput}.${hmac(signingInput, secret).toString('base64url')}`;
}

/** 형식·알고리즘·서명을 확인하고 페이로드를 돌려준다. 클레임 내용은 호출한 쪽이 확인한다. */
export function verifyJwt(token: string, secret: Buffer): Record<string, unknown> {
  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) throw new TokenError('length');
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('format');
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

  const header = decodeSegment(headerPart, 'header');
  // 'none'을 비롯한 다른 알고리즘은 서명을 보기도 전에 거절한다.
  if (header.alg !== 'HS256') throw new TokenError('alg');
  if (header.crit !== undefined) throw new TokenError('crit');

  if (!BASE64URL.test(signaturePart)) throw new TokenError('signature');
  const given = Buffer.from(signaturePart, 'base64url');
  const expected = hmac(`${headerPart}.${payloadPart}`, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new TokenError('signature');

  return decodeSegment(payloadPart, 'payload');
}

function audienceMatches(aud: unknown, expected: string): boolean {
  if (typeof aud === 'string') return aud === expected;
  // JWT 규격은 aud 를 배열로도 허용한다(일부 라이브러리가 값이 하나여도 배열로 쓴다).
  return Array.isArray(aud) && aud.length > 0 && aud.every((a) => typeof a === 'string') && aud.includes(expected);
}

function isWholeSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

/** 분석 토큰 검증: 서명, iss, aud, 만료, 필수 클레임. */
export function verifySessionToken(token: string, secret: Buffer, nowSec: number): SessionClaims {
  const payload = verifyJwt(token, secret);
  if (payload.iss !== SESSION_ISSUER) throw new TokenError('iss');
  if (!audienceMatches(payload.aud, SESSION_AUDIENCE)) throw new TokenError('aud');
  if (!isWholeSeconds(payload.exp)) throw new TokenError('exp');
  if (payload.exp <= nowSec) throw new TokenError('expired');
  if (!isWholeSeconds(payload.iat) || payload.iat > nowSec + CLOCK_SKEW_SEC || payload.iat > payload.exp) {
    throw new TokenError('iat');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0 || payload.sub.length > 64) {
    throw new TokenError('sub');
  }
  if (typeof payload.cid !== 'number' || !Number.isSafeInteger(payload.cid) || payload.cid <= 0) {
    throw new TokenError('cid');
  }
  if (payload.src !== 'HOME' && payload.src !== 'INSTITUTION') throw new TokenError('src');
  if (typeof payload.jti !== 'string' || !JTI_FORMAT.test(payload.jti)) throw new TokenError('jti');
  return {
    sub: payload.sub,
    cid: payload.cid,
    src: payload.src,
    jti: payload.jti,
    iat: payload.iat,
    exp: payload.exp,
  };
}

export interface ReceiptInput {
  session: SessionClaims;
  /** 검사를 마친 관찰 기록 객체. */
  obs: unknown;
  modelVersion: string;
  promptVersion: string;
  frameCount: number;
}

/** 영수증 발급: 분석 토큰의 sub·cid·src·jti 를 그대로 옮기고 관찰 기록을 담아 서명한다. */
export function signReceipt(input: ReceiptInput, secret: Buffer, nowSec: number): string {
  return signJwt(
    {
      iss: RECEIPT_ISSUER,
      aud: RECEIPT_AUDIENCE,
      sub: input.session.sub,
      cid: input.session.cid,
      src: input.session.src,
      jti: input.session.jti,
      obs: input.obs,
      mv: input.modelVersion,
      pv: input.promptVersion,
      fc: input.frameCount,
      iat: nowSec,
      exp: nowSec + RECEIPT_TTL_SEC,
    },
    secret,
  );
}
