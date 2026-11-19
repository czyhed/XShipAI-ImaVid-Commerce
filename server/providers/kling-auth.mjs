// 可灵（Kling）鉴权：用 AccessKey + SecretKey 现签 HS256 JWT，放在 Authorization: Bearer 里。
// 渠道只有一个加密密钥字段，这里约定存成 `accessKey:secretKey`；两段都不允许含冒号。
import { createHmac } from 'node:crypto';
import { AppError } from '../errors.mjs';

export const KLING_BASE_URL = 'https://api-beijing.klingai.com';
const PART = /^[A-Za-z0-9_\-]{8,200}$/;

export function packKlingSecret(accessKey, secretKey) {
  const ak = String(accessKey ?? '').trim(), sk = String(secretKey ?? '').trim();
  if (!PART.test(ak) || !PART.test(sk)) throw new AppError('INVALID_API_KEY', '请同时填写正确的 AccessKey 与 SecretKey（只含字母、数字、下划线或连字符）。', 422);
  return `${ak}:${sk}`;
}

export function unpackKlingSecret(secret) {
  const [accessKey, secretKey, ...rest] = String(secret ?? '').split(':');
  if (rest.length || !PART.test(accessKey || '') || !PART.test(secretKey || '')) throw new AppError('INVALID_API_KEY', '可灵渠道密钥格式不正确，请重新填写 AccessKey 与 SecretKey。', 422);
  return { accessKey, secretKey };
}

const b64url = value => Buffer.from(value).toString('base64url');

// 有效期默认 30 分钟，nbf 提前 5 秒以容忍时钟偏差。
export function klingJwt(secret, nowSeconds = Math.floor(Date.now() / 1000), ttlSeconds = 1800) {
  const { accessKey, secretKey } = unpackKlingSecret(secret);
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: accessKey, exp: nowSeconds + ttlSeconds, nbf: nowSeconds - 5 }));
  const signature = createHmac('sha256', secretKey).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}
