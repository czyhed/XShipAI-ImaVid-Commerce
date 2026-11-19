import { AppError } from '../errors.mjs';
import { requestJson, downloadMedia } from './creation-http.mjs';

// 可灵对口型（Advanced Lip Sync）分两步：
// 1. identify-face 识别底片里的人脸，得到 session_id 与 face_id；
// 2. advanced-lip-sync 用 session_id + 人脸 + 音频提交任务，只替换嘴部，其余画面沿用底片。
// 视频必须是供应商可访问的公网 https 地址；音频按官方允许的方式内联为 Base64（≤5 MB）。

export const KLING_AUDIO_MAX_BYTES = 5 * 1024 * 1024;
export const KLING_LIPSYNC_MIN_SECONDS = 2;
export const KLING_LIPSYNC_MAX_SECONDS = 60;
const AUDIO_MIME = new Set(['audio/mpeg', 'audio/wav', 'audio/mp4', 'audio/x-m4a', 'audio/aac']);
const STATUS_MAP = { submitted: 'running', processing: 'running', succeed: 'succeeded', failed: 'failed' };

// 可灵成功时 code 为 "0" 或 0；其余都按拒绝处理。
function unwrap(response) {
  const code = response?.code;
  if (code !== undefined && String(code) !== '0') {
    const message = typeof response?.message === 'string' ? response.message.trim().slice(0, 200) : '';
    throw new AppError('PROVIDER_REJECTED', message ? `可灵拒绝了请求：${message}` : '可灵拒绝了请求，请检查渠道与素材。', 502);
  }
  return response?.data && typeof response.data === 'object' ? response.data : {};
}

export function lipSyncAudio(audio) {
  const bytes = audio?.bytes ? Buffer.from(audio.bytes) : null;
  if (!bytes?.length) throw new AppError('LIPSYNC_AUDIO_INVALID', '没有可用的配音音频，请先合成配音。', 422);
  if (bytes.length > KLING_AUDIO_MAX_BYTES) throw new AppError('LIPSYNC_AUDIO_INVALID', '配音音频超过 5 MB，请缩短台词后重新合成。', 422);
  if (!AUDIO_MIME.has(audio.mime)) throw new AppError('LIPSYNC_AUDIO_INVALID', '配音音频需为 MP3、WAV 或 M4A。', 422);
  return `data:${audio.mime};base64,${bytes.toString('base64')}`;
}

export function lipSyncSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < KLING_LIPSYNC_MIN_SECONDS || seconds > KLING_LIPSYNC_MAX_SECONDS) {
    throw new AppError('LIPSYNC_AUDIO_INVALID', `对口型配音需为 ${KLING_LIPSYNC_MIN_SECONDS}–${KLING_LIPSYNC_MAX_SECONDS} 秒。`, 422);
  }
  return seconds;
}

function publicVideoUrl(value) {
  let url;
  try { url = new URL(String(value)); } catch { throw new AppError('LIPSYNC_VIDEO_INVALID', '底片地址无效。', 422); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new AppError('LIPSYNC_VIDEO_INVALID', '可灵只接受公网 HTTPS 的底片地址。', 422);
  return url.href;
}

export async function submitLipSync(transport, channel, { videoUrl, audio, durationSec, faceId = '' } = {}) {
  const url = publicVideoUrl(videoUrl);
  const seconds = lipSyncSeconds(durationSec);
  const soundFile = lipSyncAudio(audio);
  const identified = unwrap(await requestJson(transport, channel, '/v1/videos/identify-face', { method: 'POST', body: { video_url: url }, timeoutMs: 120000 }));
  const sessionId = identified.session_id;
  if (typeof sessionId !== 'string' || !sessionId) throw new AppError('PROVIDER_RESPONSE_INVALID', '可灵没有返回人脸识别会话，请稍后重试。', 502);
  const faces = (Array.isArray(identified.face_data) ? identified.face_data : [])
    .filter(face => face && face.face_id !== undefined && face.face_id !== null)
    .map(face => ({ id: String(face.face_id), image: typeof face.face_image === 'string' ? face.face_image : null, startTime: Number(face.start_time) || 0, endTime: Number(face.end_time) || 0 }));
  if (!faces.length) throw new AppError('LIPSYNC_FACE_NOT_FOUND', '没有在底片里识别到人脸；请换成正脸清晰、2–60 秒的底片。', 422);
  const face = faces.find(item => String(faceId) === item.id) || (faces.length === 1 ? faces[0] : null);
  if (!face) {
    const error = new AppError('LIPSYNC_FACE_CHOICE', '底片里有多张脸，请先选择要对口型的人脸。', 422);
    error.faces = faces;
    throw error;
  }
  const created = unwrap(await requestJson(transport, channel, '/v1/videos/advanced-lip-sync', {
    method: 'POST',
    timeoutMs: 180000,
    body: {
      session_id: sessionId,
      face_choose: [{
        face_id: face.id,
        sound_file: soundFile,
        sound_insert_time: 0,
        sound_start_time: 0,
        sound_end_time: Math.round(seconds * 1000),
        sound_volume: 1,
        original_audio_volume: 1,
      }],
      watermark_info: { enabled: true },
    },
  }));
  const taskId = created.task_id;
  if (typeof taskId !== 'string' || !taskId) throw new AppError('PROVIDER_RESPONSE_INVALID', '可灵没有返回任务编号，请稍后重试。', 502);
  return { status: 'running', upstreamId: taskId, channelId: channel.id, sessionId, face, faces };
}

export async function pollLipSync(transport, channel, upstreamId) {
  if (typeof upstreamId !== 'string' || !upstreamId) return { status: 'unknown' };
  const data = unwrap(await requestJson(transport, channel, '/v1/videos/advanced-lip-sync/' + encodeURIComponent(upstreamId)));
  const status = STATUS_MAP[String(data.task_status || '')] || 'running';
  if (status === 'succeeded') {
    const result = Array.isArray(data.task_result?.videos) ? data.task_result.videos[0] : null;
    if (typeof result?.url !== 'string') throw new AppError('PROVIDER_RESPONSE_INVALID', '成功任务缺少结果地址，请恢复原任务。', 502);
    return { status, upstreamId, ...(await downloadMedia(transport, result.url, 'video')) };
  }
  if (status === 'failed') {
    const reason = typeof data.task_status_msg === 'string' ? data.task_status_msg.trim().slice(0, 300) : '';
    return { status, upstreamId, error: { code: 'PROVIDER_GENERATION_FAILED', message: reason ? `可灵对口型失败：${reason}` : '可灵对口型失败，请检查底片和配音后手动重试。' } };
  }
  return { status, upstreamId };
}
