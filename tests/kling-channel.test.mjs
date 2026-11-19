import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { klingJwt, packKlingSecret, unpackKlingSecret, KLING_BASE_URL } from '../server/providers/kling-auth.mjs';
import { channelSecret, normalizeBaseUrl, validateProtocol } from '../server/channels.mjs';

test('kling secret packs and unpacks AccessKey + SecretKey and rejects bad input', () => {
 const packed = packKlingSecret('AKtest12345', 'SKtest67890');
 assert.deepEqual(unpackKlingSecret(packed), { accessKey: 'AKtest12345', secretKey: 'SKtest67890' });
 assert.throws(() => packKlingSecret('', 'SKtest67890'), /AccessKey/);
 assert.throws(() => packKlingSecret('AK:bad12345', 'SKtest67890'), /AccessKey/);
 assert.throws(() => unpackKlingSecret('only-one-part-1234'), /格式不正确/);
});

test('kling JWT is HS256 with iss=AccessKey, exp and nbf, and verifies with the SecretKey', () => {
 const secret = packKlingSecret('AKtest12345', 'SKtest67890');
 const token = klingJwt(secret, 1_000_000);
 const [head, body, signature] = token.split('.');
 assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), { alg: 'HS256', typ: 'JWT' });
 assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url')), { iss: 'AKtest12345', exp: 1_001_800, nbf: 999_995 });
 assert.equal(signature, createHmac('sha256', 'SKtest67890').update(`${head}.${body}`).digest('base64url'));
});

test('kling channel has a fixed base URL, no executor config, and a combined secret', () => {
 assert.equal(normalizeBaseUrl('https://evil.example.com', 'kling'), KLING_BASE_URL);
 assert.deepEqual(validateProtocol('kling', {}), {});
 assert.throws(() => validateProtocol('kling', { video: 'minimax-h3' }), /不需要执行器配置/);
 assert.equal(channelSecret('kling', { accessKey: 'AKtest12345', secretKey: 'SKtest67890' }), 'AKtest12345:SKtest67890');
 assert.equal(channelSecret('kling', {}, { required: false }), undefined);
 assert.throws(() => channelSecret('kling', { accessKey: 'AKtest12345' }), /同时填写/);
 assert.equal(channelSecret('openai-compatible', { apiKey: 'sk-12345678' }), 'sk-12345678');
});
