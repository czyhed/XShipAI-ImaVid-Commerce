import { AppError } from '../errors.mjs';
import { requestJson, downloadMedia } from './creation-http.mjs';
import { uploadObject, presignedGetUrl } from './oss-transfer.mjs';

// 阿里云百炼 VideoRetalk（声动人像）：输入一段人物视频 + 一段音频，只替换口型。
// 异步任务：提交时带 X-DashScope-Async: enable，随后轮询 /api/v1/tasks/{task_id}。
// 便宜、按秒后付费（约 ¥0.08/秒，含免费额度），无需购买资源包；仅华北2（北京）区域可用。

export const ALIYUN_LIPSYNC_BASE_URL = 'https://dashscope.aliyuncs.com';
export const ALIYUN_LIPSYNC_MIN_SECONDS = 2;
export const ALIYUN_LIPSYNC_MAX_SECONDS = 120;
const STATUS_MAP = { PENDING: 'running', RUNNING: 'running', SUCCEEDED: 'succeeded', FAILED: 'failed', CANCELED: 'cancelled', UNKNOWN: 'running' };

export function aliyunSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= ALIYUN_LIPSYNC_MIN_SECONDS || seconds >= ALIYUN_LIPSYNC_MAX_SECONDS) {
    throw new AppError('LIPSYNC_AUDIO_INVALID', `阿里云对口型要求配音时长在 ${ALIYUN_LIPSYNC_MIN_SECONDS}–${ALIYUN_LIPSYNC_MAX_SECONDS} 秒之间。`, 422);
  }
  return seconds;
}

function publicHttps(value, label) {
  let url;
  try { url = new URL(String(value)); } catch { throw new AppError('LIPSYNC_VIDEO_INVALID', `${label}地址无效。`, 422); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new AppError('LIPSYNC_VIDEO_INVALID', `${label}必须是公网 HTTPS 地址。`, 422);
  return url.href;
}

function outputOf(response) {
  if (response?.code) throw new AppError('PROVIDER_REJECTED', String(response.message || '阿里云拒绝了请求。').slice(0, 200), 502);
  return response?.output && typeof response.output === 'object' ? response.output : {};
}

// 素材交给阿里云的方式有两种：
// 1. 配了 OSS 中转：先把视频和音频上传到用户自己的私有 Bucket，再用 1 小时签名链接，供应商完全不访问平台服务器；
// 2. 没配 OSS：沿用平台短期签名链接，要求服务器对公网开放标准 HTTPS 端口。
async function deliver(transport, channel, { video, audio, videoUrl, audioUrl }) {
  if (channel.oss) {
    if (!video?.bytes || !audio?.bytes) throw new AppError('LIPSYNC_VIDEO_INVALID', '读取底片或配音失败，请重新生成后再试。', 422);
    const [videoKey, audioKey] = await Promise.all([
      uploadObject(transport, channel.oss, { bytes: video.bytes, mime: video.mime }),
      uploadObject(transport, channel.oss, { bytes: audio.bytes, mime: audio.mime }),
    ]);
    return { videoUrl: presignedGetUrl(channel.oss, videoKey, 3600), audioUrl: presignedGetUrl(channel.oss, audioKey, 3600) };
  }
  if (!videoUrl || !audioUrl) throw new AppError('PUBLIC_MEDIA_UNAVAILABLE', '服务器没有可用的公网媒体地址，请在渠道里配置 OSS 中转。', 422);
  return { videoUrl, audioUrl };
}

export async function submitAliyunLipSync(transport, channel, { video, audio, videoUrl, audioUrl, refImageUrl = '', durationSec } = {}) {
  const sources = await deliver(transport, channel, { video, audio, videoUrl, audioUrl });
  const video_ = publicHttps(sources.videoUrl, '底片');
  const audio_ = publicHttps(sources.audioUrl, '配音音频');
  aliyunSeconds(durationSec);
  const body = {
    model: 'videoretalk',
    input: { video_url: video_, audio_url: audio_, ...(refImageUrl ? { ref_image_url: publicHttps(refImageUrl, '参考人脸') } : {}) },
    // 音频比视频短时补帧到音频长度；两者等长时保持原样。
    parameters: { video_extension: false },
  };
  const response = await requestJson(transport, channel, '/api/v1/services/aigc/image2video/video-synthesis', {
    method: 'POST', body, timeoutMs: 120000, headers: { 'X-DashScope-Async': 'enable' },
  });
  const output = outputOf(response);
  if (typeof output.task_id !== 'string' || !output.task_id) throw new AppError('PROVIDER_RESPONSE_INVALID', '阿里云没有返回任务编号，请稍后重试。', 502);
  return { status: 'running', upstreamId: output.task_id, channelId: channel.id };
}

export async function pollAliyunLipSync(transport, channel, upstreamId) {
  if (typeof upstreamId !== 'string' || !upstreamId) return { status: 'unknown' };
  const response = await requestJson(transport, channel, '/api/v1/tasks/' + encodeURIComponent(upstreamId));
  const output = outputOf(response);
  const status = STATUS_MAP[String(output.task_status || '').toUpperCase()] || 'running';
  if (status === 'succeeded') {
    if (typeof output.video_url !== 'string') throw new AppError('PROVIDER_RESPONSE_INVALID', '成功任务缺少结果地址，请恢复原任务。', 502);
    return { status, upstreamId, ...(await downloadMedia(transport, output.video_url, 'video')) };
  }
  if (status === 'failed') {
    const reason = typeof output.message === 'string' ? output.message.trim().slice(0, 300) : typeof response?.message === 'string' ? response.message.trim().slice(0, 300) : '';
    return { status, upstreamId, error: { code: 'PROVIDER_GENERATION_FAILED', message: reason ? `阿里云对口型失败：${reason}` : '阿里云对口型失败，请检查底片和配音后手动重试。' } };
  }
  return { status, upstreamId };
}
