import test from 'node:test';
import assert from 'node:assert/strict';
import { submitAliyunLipSync, pollAliyunLipSync, aliyunSeconds, ALIYUN_LIPSYNC_BASE_URL } from '../server/providers/creation-aliyun-lipsync.mjs';
import { normalizeBaseUrl, validateProtocol } from '../server/channels.mjs';

const channel = { id: 'ch_00000000000000bb', adapter: 'aliyun-lipsync', baseUrl: ALIYUN_LIPSYNC_BASE_URL, apiKey: 'sk-dashscope-12345678' };
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function fakeTransport(routes) {
 const calls = [];
 const transport = async (url, options = {}) => {
  calls.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body });
  for (const [match, respond] of routes) if (url.includes(match)) return respond();
  throw new Error('unexpected ' + url);
 };
 return { transport, calls };
}

test('aliyun lip sync submits an async videoretalk task with public urls', async () => {
 const { transport, calls } = fakeTransport([['/api/v1/services/aigc/image2video/video-synthesis', () => json({ request_id: 'r1', output: { task_id: 't1', task_status: 'PENDING' } })]]);
 const result = await submitAliyunLipSync(transport, channel, { videoUrl: 'https://cdn.example.com/base.mp4', audioUrl: 'https://cdn.example.com/voice.mp3', durationSec: 8 });
 assert.equal(result.upstreamId, 't1');
 assert.equal(calls[0].headers['X-DashScope-Async'], 'enable');
 assert.equal(calls[0].headers.Authorization, 'Bearer sk-dashscope-12345678');
 const body = JSON.parse(calls[0].body);
 assert.equal(body.model, 'videoretalk');
 assert.deepEqual(body.input, { video_url: 'https://cdn.example.com/base.mp4', audio_url: 'https://cdn.example.com/voice.mp3' });
 assert.equal(body.parameters.video_extension, false);
});

test('aliyun lip sync rejects non-https sources and out-of-range durations', async () => {
 const { transport } = fakeTransport([]);
 await assert.rejects(submitAliyunLipSync(transport, channel, { videoUrl: 'http://cdn.example.com/base.mp4', audioUrl: 'https://cdn.example.com/voice.mp3', durationSec: 8 }), /HTTPS/);
 await assert.rejects(submitAliyunLipSync(transport, channel, { videoUrl: 'https://cdn.example.com/base.mp4', audioUrl: 'https://cdn.example.com/voice.mp3', durationSec: 2 }), /2–120/);
 await assert.rejects(submitAliyunLipSync(transport, channel, { videoUrl: 'https://cdn.example.com/base.mp4', audioUrl: 'https://cdn.example.com/voice.mp3', durationSec: 120 }), /2–120/);
 assert.equal(aliyunSeconds(8), 8);
});

test('aliyun lip sync polls tasks and downloads the result', async () => {
 const videoBytes = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(32)]);
 const pending = fakeTransport([['/api/v1/tasks/t2', () => json({ output: { task_id: 't2', task_status: 'RUNNING' } })]]);
 assert.equal((await pollAliyunLipSync(pending.transport, channel, 't2')).status, 'running');
 const done = fakeTransport([
  ['/api/v1/tasks/t3', () => json({ output: { task_id: 't3', task_status: 'SUCCEEDED', video_url: 'https://oss.example.com/out.mp4' } })],
  ['https://oss.example.com/out.mp4', () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': String(videoBytes.length) }), body: (async function* () { yield videoBytes; })() })],
 ]);
 const result = await pollAliyunLipSync(done.transport, channel, 't3');
 assert.equal(result.status, 'succeeded');
 assert.equal(result.mime, 'video/mp4');
 const failed = fakeTransport([['/api/v1/tasks/t4', () => json({ output: { task_status: 'FAILED', message: 'bad face' } })]]);
 const failure = await pollAliyunLipSync(failed.transport, channel, 't4');
 assert.equal(failure.status, 'failed');
 assert.match(failure.error.message, /bad face/);
});

test('aliyun lip sync upgrades an http result url to https before downloading', async () => {
 const bytes = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(32)]);
 const { transport, calls } = fakeTransport([
  ['/api/v1/tasks/t5', () => json({ output: { task_id: 't5', task_status: 'SUCCEEDED', video_url: 'http://oss.example.com/out.mp4' } })],
  ['https://oss.example.com/out.mp4', () => ({ ok: true, status: 200, headers: new Headers({ 'content-length': String(bytes.length) }), body: (async function* () { yield bytes; })() })],
 ]);
 const result = await pollAliyunLipSync(transport, channel, 't5');
 assert.equal(result.status, 'succeeded');
 assert.equal(result.mime, 'video/mp4');
 assert.ok(calls.some(call => call.url === 'https://oss.example.com/out.mp4'), '结果应按 https 下载');
 assert.ok(!calls.some(call => call.url.startsWith('http://')), '不应有明文下载请求');
});

test('aliyun lip sync channel has a fixed Beijing endpoint and no executor config', () => {
 assert.equal(normalizeBaseUrl('https://evil.example.com', 'aliyun-lipsync'), ALIYUN_LIPSYNC_BASE_URL);
 assert.deepEqual(validateProtocol('aliyun-lipsync', {}), {});
 assert.throws(() => validateProtocol('aliyun-lipsync', { video: 'minimax-h3' }), /不需要执行器配置/);
});
