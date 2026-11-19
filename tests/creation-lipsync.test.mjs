import test from 'node:test';
import assert from 'node:assert/strict';
import { submitLipSync, pollLipSync, lipSyncAudio, lipSyncSeconds } from '../server/providers/creation-lipsync.mjs';

const channel = { id: 'ch_00000000000000aa', adapter: 'kling', baseUrl: 'https://api-beijing.klingai.com', apiKey: 'AKtest12345:SKtest67890' };
const audio = { bytes: Buffer.from([0xff, 0xfb, 0x90, 0x64, 1, 2, 3, 4]), mime: 'audio/mpeg' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = body => json(body);

function fakeTransport(routes) {
 const calls = [];
 const transport = async (url, options = {}) => {
  calls.push({ url, method: options.method || 'GET', headers: options.headers || {}, body: options.body });
  for (const [match, respond] of routes) if (url.includes(match)) return respond(options);
  throw new Error('unexpected ' + url);
 };
 return { transport, calls };
}

test('lip sync validates audio format, size and duration', () => {
 assert.ok(lipSyncAudio({ bytes: Buffer.alloc(4), mime: 'audio/mpeg' }).startsWith('data:audio/mpeg;base64,'));
 assert.throws(() => lipSyncAudio({ bytes: Buffer.alloc(4), mime: 'audio/ogg' }), /MP3/);
 assert.throws(() => lipSyncAudio({ bytes: Buffer.alloc(5 * 1024 * 1024 + 1), mime: 'audio/mpeg' }), /5 MB/);
 assert.throws(() => lipSyncAudio({}), /没有可用的配音/);
 assert.equal(lipSyncSeconds(8), 8);
 assert.throws(() => lipSyncSeconds(1), /2–60/);
 assert.throws(() => lipSyncSeconds(61), /2–60/);
});

test('lip sync identifies the face, signs the JWT and submits one face with inline audio', async () => {
 const { transport, calls } = fakeTransport([
  ['/v1/videos/identify-face', () => json({ code: 0, message: '', data: { session_id: 'sess-1', face_data: [{ face_id: '0', face_image: 'https://img/face.png', start_time: 0, end_time: 8000 }] } })],
  ['/v1/videos/advanced-lip-sync', () => json({ code: 0, data: { task_id: 'task-1', task_status: 'submitted' } })],
 ]);
 const result = await submitLipSync(transport, channel, { videoUrl: 'https://cdn.example.com/base.mp4', audio, durationSec: 8 });
 assert.equal(result.upstreamId, 'task-1');
 assert.equal(result.face.id, '0');
 assert.equal(calls.length, 2);
 assert.deepEqual(JSON.parse(calls[0].body), { video_url: 'https://cdn.example.com/base.mp4' });
 const [, token] = calls[0].headers.Authorization.split(' ');
 const [, payload] = token.split('.');
 assert.equal(JSON.parse(Buffer.from(payload, 'base64url')).iss, 'AKtest12345');
 const body = JSON.parse(calls[1].body);
 assert.equal(body.session_id, 'sess-1');
 assert.equal(body.face_choose.length, 1);
 assert.equal(body.face_choose[0].face_id, '0');
 assert.equal(body.face_choose[0].sound_file, `data:audio/mpeg;base64,${audio.bytes.toString('base64')}`);
 assert.equal(body.face_choose[0].sound_end_time, 8000);
 assert.equal(body.watermark_info.enabled, true);
});

test('lip sync asks for a face when the base video has several faces', async () => {
 const faces = [{ face_id: '0' }, { face_id: '1' }];
 const { transport } = fakeTransport([['/v1/videos/identify-face', () => json({ code: 0, data: { session_id: 's', face_data: faces } })]]);
 await assert.rejects(submitLipSync(transport, channel, { videoUrl: 'https://cdn.example.com/base.mp4', audio, durationSec: 8 }), error => {
  assert.equal(error.code, 'LIPSYNC_FACE_CHOICE');
  assert.equal(error.faces.length, 2);
  return true;
 });
});

test('lip sync polls the task and downloads the finished video', async () => {
 const videoBytes = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom', 'ascii'), Buffer.alloc(64)]);
 const { transport } = fakeTransport([
  ['/v1/videos/advanced-lip-sync/task-1', () => text({ code: 0, data: { task_status: 'succeed', task_result: { videos: [{ url: 'https://cdn.example.com/out.mp4', duration: '8' }] } } })],
  ['https://cdn.example.com/out.mp4', () => ({
   ok: true, status: 200, headers: new Map([['content-length', String(videoBytes.length)]]),
   body: (async function* () { yield videoBytes; })(),
  })],
 ]);
 const result = await pollLipSync(transport, channel, 'task-1');
 assert.equal(result.status, 'succeeded');
 assert.equal(result.mime, 'video/mp4');
 assert.equal(result.bytes.length, videoBytes.length);
});

test('lip sync passes through running and failed states', async () => {
 const running = fakeTransport([['/v1/videos/advanced-lip-sync/task-2', () => text({ code: 0, data: { task_status: 'processing' } })]]);
 assert.equal((await pollLipSync(running.transport, channel, 'task-2')).status, 'running');
 const failed = fakeTransport([['/v1/videos/advanced-lip-sync/task-3', () => text({ code: 0, data: { task_status: 'failed', task_status_msg: 'audio too long' } })]]);
 const result = await pollLipSync(failed.transport, channel, 'task-3');
 assert.equal(result.status, 'failed');
 assert.match(result.error.message, /audio too long/);
});
