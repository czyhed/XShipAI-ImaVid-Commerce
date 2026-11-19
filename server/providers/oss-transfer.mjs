import { createHmac, randomUUID } from 'node:crypto';
import { AppError } from '../errors.mjs';

// 阿里云 OSS 中转：把底片和配音先传到用户自己的私有 Bucket，再给 VideoRetalk 一个 1 小时有效的签名链接。
// 这样外部供应商不需要访问平台服务器的任何端口，也就不受服务器防火墙限制。
// 只实现用到的两个动作：PUT 上传对象、预签名 GET；签名算法是 OSS V1（HMAC-SHA1）。

const BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;
const REGION = /^oss-[a-z0-9][a-z0-9-]{2,30}$/;
const ACCESS_KEY = /^[A-Za-z0-9._-]{6,64}$/;
const MIME_EXT = {
 'video/mp4': 'mp4',
 'audio/mpeg': 'mp3',
 'audio/mp3': 'mp3',
 'audio/wav': 'wav',
 'audio/x-wav': 'wav',
 'audio/mp4': 'm4a',
 'audio/m4a': 'm4a',
 'audio/aac': 'aac',
};

// 四个字段要么都不填（不用 OSS），要么都填齐；任何一项格式不对都在保存时就拒绝。
export function normalizeOss(value) {
 if (value === undefined || value === null || value === '') return null;
 if (typeof value === 'string') return null;
 if (typeof value !== 'object' || Array.isArray(value)) throw new AppError('OSS_CONFIG_INVALID', 'OSS 配置格式不正确。', 422);
 const bucket = String(value.bucket ?? '').trim();
 const region = String(value.region ?? '').trim();
 const accessKeyId = String(value.accessKeyId ?? '').trim();
 const accessKeySecret = String(value.accessKeySecret ?? '').trim();
 if (!bucket && !region && !accessKeyId && !accessKeySecret) return null;
 if (![bucket, region, accessKeyId, accessKeySecret].every(Boolean)) throw new AppError('OSS_CONFIG_INVALID', 'OSS 中转需要同时填写 Bucket、地域、AccessKey ID 和 AccessKey Secret。', 422);
 if (!BUCKET.test(bucket)) throw new AppError('OSS_CONFIG_INVALID', 'OSS Bucket 名称格式不正确。', 422);
 if (!REGION.test(region)) throw new AppError('OSS_CONFIG_INVALID', 'OSS 地域格式不正确，例如 oss-cn-beijing。', 422);
 if (!ACCESS_KEY.test(accessKeyId)) throw new AppError('OSS_CONFIG_INVALID', 'OSS AccessKey ID 格式不正确。', 422);
 if (accessKeySecret.length < 8 || accessKeySecret.length > 200 || /[\r\n]/.test(accessKeySecret)) throw new AppError('OSS_CONFIG_INVALID', 'OSS AccessKey Secret 格式不正确。', 422);
 return { bucket, region, accessKeyId, accessKeySecret };
}

// 阿里云渠道把 DashScope Key 与可选的 OSS 配置一起加密保存：有 OSS 时存 JSON，没有时沿用纯 Key。
export function packAliyunSecret(apiKey, oss) {
 return oss ? JSON.stringify({ apiKey, oss }) : apiKey;
}
export function unpackAliyunSecret(secret) {
 const text = String(secret ?? '');
 if (!text.startsWith('{')) return { apiKey: text, oss: null };
 try {
  const parsed = JSON.parse(text);
  if (typeof parsed?.apiKey === 'string') return { apiKey: parsed.apiKey, oss: normalizeOss(parsed.oss) };
 } catch {}
 return { apiKey: text, oss: null };
}

// 编辑渠道时允许只改其中几项：留空的字段沿用已保存的值；四项最终都要有值才算配置完成。
// incoming === null 表示明确清除；undefined 表示保持原样。
export function mergeOss(current, incoming) {
 if (incoming === undefined) return current || null;
 if (incoming === null || incoming === '') return null;
 const src = incoming && typeof incoming === 'object' && !Array.isArray(incoming) ? incoming : {};
 const pick = key => String(src[key] ?? '').trim() || String(current?.[key] ?? '').trim();
 const merged = { bucket: pick('bucket'), region: pick('region'), accessKeyId: pick('accessKeyId'), accessKeySecret: pick('accessKeySecret') };
 if (!Object.values(merged).some(Boolean)) return null;
 return normalizeOss(merged);
}

const hostOf = oss => `${oss.bucket}.${oss.region}.aliyuncs.com`;
const hmac = (secret, text) => createHmac('sha1', secret).update(text).digest('base64');
// StringToSign：VERB\nContent-MD5\nContent-Type\nDate|Expires\nCanonicalizedOSSHeaders + CanonicalizedResource
// CanonicalizedOSSHeaders 每条自带结尾换行；没有 x-oss-* 头时这一项为空，
// 所以 Date 与资源路径之间只有一个换行（多一个空行会得到 SignatureDoesNotMatch）。
const stringToSign = (verb, contentType, dateOrExpires, resource) => [verb, '', contentType, dateOrExpires, resource].join('\n');

export function presignedGetUrl(oss, key, ttlSeconds = 3600) {
 const expires = Math.floor(Date.now() / 1000) + Math.min(Math.max(Number(ttlSeconds) || 3600, 60), 86400);
 const signature = hmac(oss.accessKeySecret, stringToSign('GET', '', String(expires), `/${oss.bucket}/${key}`));
 return `https://${hostOf(oss)}/${key}?${new URLSearchParams({ OSSAccessKeyId: oss.accessKeyId, Expires: String(expires), Signature: signature })}`;
}

// 每次上传生成独立对象名，避免覆盖与猜测；扩展名来自 MIME，方便供应商识别格式。
export function ossObjectKey(mime) {
 const ext = MIME_EXT[String(mime || '').toLowerCase()] || 'bin';
 return `shangjing/lipsync/${new Date().toISOString().slice(0, 10)}/${randomUUID()}.${ext}`;
}

// OSS 的错误响应是 XML：<Error><Code>AccessDenied</Code><Message>…</Message></Error>。
// 403 的原因有很多种（权限、密钥、地域、桶名），把 Code 透出来才能定位。
const OSS_HINTS = {
 AccessDenied: '当前 AccessKey 所属账号没有这个 Bucket 的写入权限，请给 RAM 用户授权 oss:PutObject / oss:GetObject',
 InvalidAccessKeyId: 'AccessKey ID 不存在或已被停用，请重新生成',
 SignatureDoesNotMatch: 'AccessKey Secret 与 AccessKey ID 不匹配，请确认没有复制错或截断',
 NoSuchBucket: 'Bucket 不存在，请核对 Bucket 名称和地域',
 SecondLevelDomainForbidden: 'Bucket 名称与访问地址不匹配，请核对 Bucket 名',
 RequestTimeTooSkewed: '服务器时间与阿里云相差过大',
 InvalidBucketName: 'Bucket 名称格式不正确',
};
async function ossFailure(response) {
 const region = String(response.headers?.get?.('x-oss-bucket-region') || '').trim();
 let code = '', message = '';
 try {
  const chunks = []; let size = 0;
  if (response.body) for await (const chunk of response.body) { size += chunk.length; if (size > 8192) break; chunks.push(Buffer.from(chunk)); }
  const text = Buffer.concat(chunks).toString('utf8');
  code = (/<Code>([^<]{1,120})<\/Code>/.exec(text) || [])[1] || '';
  message = (/<Message>([^<]{1,300})<\/Message>/.exec(text) || [])[1] || '';
 } catch {}
 try { await response.body?.cancel?.(); } catch {}
 if (!code && region && [301, 302, 307, 308].includes(response.status)) code = 'WrongRegion';
 const parts = [code, message.replace(/https?:\/\/\S+/g, '[链接]').replace(/\s+/g, ' ').trim().slice(0, 160)].filter(Boolean);
 if (region && /WrongRegion|AccessDenied|SecondLevelDomain/.test(code)) parts.push(`该 Bucket 实际地域为 ${region}`);
 const hint = OSS_HINTS[code] || '请检查 Bucket 权限、地域和 AccessKey';
 const detail = parts.length ? `，${parts.join('：')}` : '';
 return new AppError('OSS_UPLOAD_FAILED', `素材上传到 OSS 失败（HTTP ${response.status}${detail}）。${hint}。`, 502);
}

export async function uploadObject(transport, oss, { bytes, mime }) {
 const data = bytes && Buffer.from(bytes);
 const type = String(mime || '');
 if (!data?.length) throw new AppError('OSS_UPLOAD_FAILED', '要上传的素材为空。', 422);
 if (!MIME_EXT[type]) throw new AppError('OSS_UPLOAD_FAILED', '只支持上传 MP4 视频或 MP3 / WAV / M4A / AAC 音频。', 422);
 const key = ossObjectKey(type);
 const date = new Date().toUTCString();
 const signature = hmac(oss.accessKeySecret, stringToSign('PUT', type, date, `/${oss.bucket}/${key}`));
 const response = await transport(`https://${hostOf(oss)}/${key}`, {
  method: 'PUT',
  headers: { Date: date, 'Content-Type': type, 'Content-Length': String(data.length), Authorization: `OSS ${oss.accessKeyId}:${signature}` },
  body: data,
 });
 if (!response.ok) throw await ossFailure(response);
 await response.body?.cancel?.().catch?.(() => {});
 return key;
}
