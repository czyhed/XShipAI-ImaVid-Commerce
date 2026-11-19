import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
 normalizeOss, mergeOss, packAliyunSecret, unpackAliyunSecret, presignedGetUrl, uploadObject, ossObjectKey,
} from '../server/providers/oss-transfer.mjs';
import { submitAliyunLipSync } from '../server/providers/creation-aliyun-lipsync.mjs';

const oss = { bucket: 'my-lipsync', region: 'oss-cn-beijing', accessKeyId: 'LTAI5tExample', accessKeySecret: 'secret-value-123456' };
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

test('oss config is all-or-nothing and validates each field', () => {
 assert.equal(normalizeOss(undefined), null);
 assert.equal(normalizeOss({ bucket: '', region: '', accessKeyId: '', accessKeySecret: '' }), null);
 assert.deepEqual(normalizeOss(oss), oss);
 assert.throws(() => normalizeOss({ ...oss, accessKeySecret: '' }), /同时填写/);
 assert.throws(() => normalizeOss({ ...oss, bucket: 'Bad_Bucket' }), /Bucket/);
 assert.throws(() => normalizeOss({ ...oss, region: 'cn-beijing' }), /地域/);
});

test('aliyun secret packs the oss config with the key and unpacks both', () => {
 const packed = packAliyunSecret('sk-dashscope-123', oss);
 assert.deepEqual(unpackAliyunSecret(packed), { apiKey: 'sk-dashscope-123', oss });
 assert.deepEqual(unpackAliyunSecret('sk-plain-456'), { apiKey: 'sk-plain-456', oss: null });
 const broken = unpackAliyunSecret('{not json');
 assert.equal(broken.apiKey, '{not json');
});

test('editing keeps saved oss values when the secret fields are left blank', () => {
 assert.deepEqual(mergeOss(oss, { bucket: 'my-lipsync', region: 'oss-cn-beijing', accessKeyId: '', accessKeySecret: '' }), oss);
 assert.deepEqual(mergeOss(oss, { bucket: 'other-bucket', region: '', accessKeyId: '', accessKeySecret: '' }), { ...oss, bucket: 'other-bucket' });
 assert.deepEqual(mergeOss(oss, { bucket: '', region: '', accessKeyId: 'LTAI5tRotated', accessKeySecret: 'rotated-secret-1' }), { ...oss, accessKeyId: 'LTAI5tRotated', accessKeySecret: 'rotated-secret-1' });
 assert.equal(mergeOss(oss, null), null);
 assert.equal(mergeOss(null, { bucket: '', region: '', accessKeyId: '', accessKeySecret: '' }), null);
 assert.throws(() => mergeOss(null, { bucket: 'only-bucket' }), /同时填写/);
});

test('presigned url signs the object for one hour and carries the access key id', () => {
 const url = new URL(presignedGetUrl(oss, 'shangjing/lipsync/x.mp4', 3600));
 assert.equal(url.host, 'my-lipsync.oss-cn-beijing.aliyuncs.com');
 assert.equal(url.pathname, '/shangjing/lipsync/x.mp4');
 assert.equal(url.searchParams.get('OSSAccessKeyId'), oss.accessKeyId);
 const expires = Number(url.searchParams.get('Expires'));
 assert.ok(expires > Date.now() / 1000);
 // V1 规范：CanonicalizedOSSHeaders 为空时，Expires 与资源之间只有一个换行。
 const expected = createHmac('sha1', oss.accessKeySecret).update(`GET\n\n\n${expires}\n/my-lipsync/shangjing/lipsync/x.mp4`).digest('base64');
 assert.equal(url.searchParams.get('Signature'), expected);
});

test('upload puts bytes with an oss authorization header and rejects bad mime', async () => {
 const calls = [];
 const transport = async (url, options) => { calls.push({ url, options }); return { ok: true, status: 200, body: { cancel: async () => {} } }; };
 const key = await uploadObject(transport, oss, { bytes: Buffer.from('ftyp'), mime: 'video/mp4' });
 assert.match(key, /^shangjing\/lipsync\/\d{4}-\d{2}-\d{2}\/[\da-f-]{36}\.mp4$/);
 assert.equal(calls[0].options.method, 'PUT');
 assert.match(calls[0].options.headers.Authorization, /^OSS LTAI5tExample:/);
 assert.equal(calls[0].options.headers['Content-Type'], 'video/mp4');
 // 上传签名同样必须只有 Date 与资源之间一个换行，否则真实 OSS 返回 SignatureDoesNotMatch。
 const date = calls[0].options.headers.Date;
 const expectedAuth = 'OSS LTAI5tExample:' + createHmac('sha1', oss.accessKeySecret).update(`PUT\n\nvideo/mp4\n${date}\n/my-lipsync/${key}`).digest('base64');
 assert.equal(calls[0].options.headers.Authorization, expectedAuth);
 await assert.rejects(uploadObject(transport, oss, { bytes: Buffer.from('x'), mime: 'video/quicktime' }), /只支持上传/);
 const denied = async () => ({ ok: false, status: 403, body: { cancel: async () => {} } });
 await assert.rejects(uploadObject(denied, oss, { bytes: Buffer.from('x'), mime: 'audio/mpeg' }), /HTTP 403/);
});

test('oss upload surfaces the oss error code so the cause is diagnosable', async () => {
 const xml = '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>You have no right to access this object.</Message><RequestId>65E1</RequestId></Error>';
 const transport = async () => new Response(xml, { status: 403, headers: { 'content-type': 'application/xml' } });
 await assert.rejects(uploadObject(transport, oss, { bytes: Buffer.from('x'), mime: 'audio/mpeg' }), error => {
  assert.match(error.message, /HTTP 403/);
  assert.match(error.message, /AccessDenied/);
  assert.match(error.message, /RAM 用户授权/);
  return true;
 });
 const wrongRegion = async () => new Response('', { status: 301, headers: { 'x-oss-bucket-region': 'oss-cn-hangzhou' } });
 await assert.rejects(uploadObject(wrongRegion, oss, { bytes: Buffer.from('x'), mime: 'audio/mpeg' }), error => {
  assert.match(error.message, /oss-cn-hangzhou/);
  return true;
 });
});

test('aliyun lip sync uploads to oss and hands signed urls to videoretalk', async () => {
 const calls = [];
 const transport = async (url, options = {}) => {
  calls.push({ url, method: options.method || 'GET', body: options.body });
  if (url.startsWith('https://my-lipsync.oss-cn-beijing.aliyuncs.com/')) return { ok: true, status: 200, body: { cancel: async () => {} } };
  if (url.includes('/api/v1/services/aigc/image2video/video-synthesis')) return json({ output: { task_id: 't9' } });
  throw new Error('unexpected ' + url);
 };
 const channel = { id: 'ch_00000000000000cc', adapter: 'aliyun-lipsync', baseUrl: 'https://dashscope.aliyuncs.com', apiKey: 'sk-dashscope', oss };
 const result = await submitAliyunLipSync(transport, channel, {
  video: { bytes: Buffer.from('mp4-bytes'), mime: 'video/mp4' },
  audio: { bytes: Buffer.from('mp3-bytes'), mime: 'audio/mpeg' },
  durationSec: 8,
 });
 assert.equal(result.upstreamId, 't9');
 assert.equal(calls.filter(call => call.method === 'PUT').length, 2);
 const body = JSON.parse(calls.find(call => call.method === 'POST').body);
 assert.match(body.input.video_url, /^https:\/\/my-lipsync\.oss-cn-beijing\.aliyuncs\.com\/shangjing\/lipsync\//);
 assert.match(body.input.video_url, /OSSAccessKeyId=/);
 assert.match(body.input.audio_url, /\.mp3\?/);
});

test('aliyun lip sync without oss still accepts public urls, but needs them', async () => {
 const transport = async () => json({ output: { task_id: 't8' } });
 const channel = { id: 'ch_00000000000000dd', adapter: 'aliyun-lipsync', baseUrl: 'https://dashscope.aliyuncs.com', apiKey: 'sk-dashscope' };
 await assert.rejects(submitAliyunLipSync(transport, channel, { durationSec: 8 }), /公网媒体地址/);
 const ok = await submitAliyunLipSync(transport, channel, { videoUrl: 'https://cdn.example.com/a.mp4', audioUrl: 'https://cdn.example.com/a.mp3', durationSec: 8 });
 assert.equal(ok.upstreamId, 't8');
});
