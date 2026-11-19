import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from './errors.mjs';
import { VOLC_BASE_URL, VOLC_RESOURCES } from '../shared/creation-voice.mjs';
import { KLING_BASE_URL, packKlingSecret } from './providers/kling-auth.mjs';
import { ALIYUN_LIPSYNC_BASE_URL } from './providers/creation-aliyun-lipsync.mjs';
import { packAliyunSecret, unpackAliyunSecret, mergeOss } from './providers/oss-transfer.mjs';

const ALGORITHM = 'aes-256-gcm';
const CHANNEL_ID = /^ch_[0-9a-f]{16}$/;

export function normalizeBaseUrl(value, adapter = 'openai-compatible') {
  // 火山引擎语音渠道的地址固定，不接受自定义地址，避免密钥被发往别处。
  if (adapter === 'volcengine-tts') return VOLC_BASE_URL;
  // 可灵地址同样固定（北京节点），避免 AccessKey/SecretKey 签名的令牌被发往别处。
  if (adapter === 'kling') return KLING_BASE_URL;
  // 阿里云百炼 VideoRetalk 同样固定北京区域地址。
  if (adapter === 'aliyun-lipsync') return ALIYUN_LIPSYNC_BASE_URL;
  let url;
  try { url = new URL(String(value || '').trim()); }
  catch { throw new AppError('INVALID_BASE_URL', 'Base URL 格式不正确，请填写完整的 https 地址。', 422); }
  if (url.username || url.password) {
    throw new AppError('INVALID_BASE_URL', 'Base URL 不能包含用户名或密码。', 422);
  }
  if (url.search || url.hash) {
    throw new AppError('INVALID_BASE_URL', 'Base URL 不能包含查询参数或锚点。', 422);
  }
  const localHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !localHttp) {
    throw new AppError('INVALID_BASE_URL', '模型渠道必须使用 https；本机服务可使用 http://localhost。', 422);
  }
  let path = url.pathname.replace(/\/+$/, '');
  if (adapter !== 'minimax-h3' && !/\/v1$/.test(path)) path += '/v1';
  url.pathname = path;
  return url.toString().replace(/\/$/, '');
}

export function validateChannelName(value) {
  const name = String(value || '').trim();
  if (!name || name.length > 40) throw new AppError('INVALID_CHANNEL_NAME', '渠道名称需为 1–40 个字符。', 422);
  return name;
}

export function validateApiKey(value) {
  const key = String(value || '').trim();
  if (key.length < 8 || key.length > 500 || /[\r\n]/.test(key)) {
    throw new AppError('INVALID_API_KEY', 'API Key 格式不正确。', 422);
  }
  return key;
}

// 可灵渠道需要 AccessKey + SecretKey，合成一个加密保存的字符串；其他协议沿用单个 API Key。
export function channelSecret(adapter, body = {}, { required = true } = {}) {
  if (adapter === 'kling') {
    const has = body.accessKey || body.secretKey;
    if (!has && !required) return undefined;
    return packKlingSecret(body.accessKey, body.secretKey);
  }
  if (body.apiKey === undefined && !required) return undefined;
  return validateApiKey(body.apiKey);
}

export function newChannelId() {
  return 'ch_' + randomBytes(8).toString('hex');
}

export function loadEncryptionKey(root = process.cwd(), env = process.env) {
  if (env.CHANNEL_ENCRYPTION_KEY) {
    const key = Buffer.from(env.CHANNEL_ENCRYPTION_KEY, 'base64');
    if (key.length !== 32) {
      throw new AppError('CHANNEL_KEY_INVALID', 'CHANNEL_ENCRYPTION_KEY 必须是 32 字节的 base64。', 500);
    }
    return key;
  }
  const file = join(root, '.secrets', 'channel-encryption.key');
  if (existsSync(file)) {
    const key = readFileSync(file);
    if (key.length !== 32) {
      throw new AppError('CHANNEL_KEY_INVALID', '渠道加密密钥文件长度不正确，请恢复备份，不要直接覆盖。', 500);
    }
    return key;
  }
  const key = randomBytes(32);
  // The private directory is Git-ignored. Never expose this key through HTTP.
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}

export function encryptSecret(key, plaintext) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptSecret(key, row) {
  try {
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(row.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(row.tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(row.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new AppError('CHANNEL_KEY_UNREADABLE', '渠道密钥无法解密，请恢复 .secrets/channel-encryption.key 备份后重试。', 500);
  }
}

// 列表里的末四位提示：阿里云渠道保存的可能是含 OSS 的 JSON，提示取自真正的 Key。
function hintOf(adapter, stored) {
  const key = adapter === 'aliyun-lipsync' ? unpackAliyunSecret(stored).apiKey : stored;
  return '••••' + String(key || '').slice(-4);
}
// 对外只暴露 OSS 的非敏感信息，让再次编辑时能显示「已配置」，不需要重新输入密钥。
function ossMeta(config, oss) {
  const { oss: _previous, ...rest } = config && typeof config === 'object' ? config : {};
  return oss ? { ...rest, oss: { bucket: oss.bucket, region: oss.region, keyHint: '••••' + oss.accessKeyId.slice(-4) } } : rest;
}

export class ChannelStore {
  constructor(pool, encryptionKey) {
    this.pool = pool;
    this.encryptionKey = encryptionKey;
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS sj_model_channels (
        id text PRIMARY KEY,
        name text NOT NULL,
        adapter text NOT NULL DEFAULT 'openai-compatible',
        base_url text NOT NULL,
        key_ciphertext text NOT NULL,
        key_iv text NOT NULL,
        key_tag text NOT NULL,
        key_hint text NOT NULL,
        enabled boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      ALTER TABLE sj_model_channels ADD COLUMN IF NOT EXISTS executor_config jsonb NOT NULL DEFAULT '{}';
      ALTER TABLE sj_model_channels ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1;
      CREATE INDEX IF NOT EXISTS sj_model_channels_created
      ON sj_model_channels (created_at);
    `);
  }

  publicRow(row) {
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      adapter: row.adapter,
      executorConfig: row.executor_config || {},
      revision: row.revision || 1,
      baseUrl: row.base_url,
      keyHint: row.key_hint,
      enabled: row.enabled,
      source: 'database',
      deletable: true,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  secretRow(row) {
    const stored = decryptSecret(this.encryptionKey, {
      ciphertext: row.key_ciphertext, iv: row.key_iv, tag: row.key_tag,
    });
    // 阿里云对口型渠道可能把 OSS 中转配置和 Key 一起加密保存。
    if (row.adapter === 'aliyun-lipsync') {
      const { apiKey, oss } = unpackAliyunSecret(stored);
      return { ...this.publicRow(row), apiKey, oss };
    }
    return { ...this.publicRow(row), apiKey: stored };
  }

  async list(client=this.pool) {
    return (await client.query('SELECT * FROM sj_model_channels ORDER BY created_at ASC')).rows.map(row => this.publicRow(row));
  }

  async listSecrets() {
    return (await this.pool.query('SELECT * FROM sj_model_channels ORDER BY created_at ASC')).rows.map(row => this.secretRow(row));
  }

  async get(id) {
    if (!CHANNEL_ID.test(String(id || ''))) return null;
    return this.publicRow((await this.pool.query('SELECT * FROM sj_model_channels WHERE id=$1', [id])).rows[0]);
  }

  async getSecret(id,client=this.pool) {
    if (!CHANNEL_ID.test(String(id || ''))) return null;
    const row = (await client.query('SELECT * FROM sj_model_channels WHERE id=$1', [id])).rows[0];
    return row ? this.secretRow(row) : null;
  }

  async insert({ id, name, baseUrl, apiKey, adapter = 'openai-compatible', executorConfig = {} }) {
    if (!CHANNEL_ID.test(id)) throw new AppError('INVALID_CHANNEL_ID', '渠道编号格式不正确。', 500);
    validateProtocol(adapter, executorConfig);
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl, adapter);
    const secret = encryptSecret(this.encryptionKey, apiKey);
    const storedConfig = adapter === 'aliyun-lipsync' ? ossMeta(executorConfig, unpackAliyunSecret(apiKey).oss) : executorConfig;
    const result = await this.pool.query(`
      INSERT INTO sj_model_channels (id,name,base_url,key_ciphertext,key_iv,key_tag,key_hint,adapter,executor_config)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *
    `, [id, name, normalizedBaseUrl, secret.ciphertext, secret.iv, secret.tag, hintOf(adapter, apiKey),adapter,JSON.stringify(storedConfig)]);
    return this.publicRow(result.rows[0]);
  }

  async update(id, patch = {}) {
    const current=await this.getSecret(id);
    if(!current)throw new AppError('CHANNEL_NOT_FOUND','渠道不存在。',404);
    const adapter=patch.adapter??current.adapter;
    const config=patch.executorConfig??current.executorConfig;validateProtocol(adapter,config);
    if(patch.enabled!==undefined&&typeof patch.enabled!=='boolean')throw new AppError('INVALID_CHANNEL','启用状态需为布尔值。',422);
    const name=validateChannelName(patch.name??current.name);
    const baseUrl=normalizeBaseUrl(patch.baseUrl??current.baseUrl,adapter);
    // 阿里云渠道：Key 与可选的 OSS 中转配置一起加密保存；只改其中几项时，留空的字段沿用已保存的值。
    let apiKey, oss = null;
    if (adapter === 'aliyun-lipsync') {
      const key = patch.apiKey === undefined ? current.apiKey : validateApiKey(patch.apiKey);
      oss = mergeOss(current.adapter === 'aliyun-lipsync' ? current.oss : null, patch.oss);
      if (!key) throw new AppError('INVALID_API_KEY', '请填写百炼 API Key。', 422);
      apiKey = packAliyunSecret(key, oss);
    } else {
      apiKey = patch.apiKey === undefined ? current.apiKey : validateApiKey(patch.apiKey);
    }
    const storedConfig = adapter === 'aliyun-lipsync' ? ossMeta(config, oss) : config;
    const secret=encryptSecret(this.encryptionKey,apiKey);
    const result=await this.pool.query(`UPDATE sj_model_channels SET name=$2,adapter=$3,base_url=$4,key_ciphertext=$5,key_iv=$6,key_tag=$7,key_hint=$8,executor_config=$9,enabled=$10,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *`,[id,name,adapter,baseUrl,secret.ciphertext,secret.iv,secret.tag,hintOf(adapter,apiKey),JSON.stringify(storedConfig),patch.enabled??current.enabled]);
    return this.publicRow(result.rows[0]);
  }
  async setEnabled(id, enabled) {
    const result = await this.pool.query(
      'UPDATE sj_model_channels SET enabled=$2,revision=revision+1,updated_at=now() WHERE id=$1 RETURNING *',
      [id, enabled],
    );
    if (!result.rows[0]) throw new AppError('CHANNEL_NOT_FOUND', '渠道不存在。', 404);
    return this.publicRow(result.rows[0]);
  }

  async remove(id) {
    const result = await this.pool.query('DELETE FROM sj_model_channels WHERE id=$1 RETURNING *', [id]);
    if (!result.rows[0]) throw new AppError('CHANNEL_NOT_FOUND', '渠道不存在。', 404);
    return this.publicRow(result.rows[0]);
  }
}

export function validateProtocol(adapter, config = {}) {
  if(!['openai-compatible','anthropic','minimax-h3','volcengine-tts','kling','aliyun-lipsync'].includes(adapter)) throw new AppError('INVALID_PROTOCOL','请选择 OpenAI、Anthropic、MiniMax H3、火山引擎语音、可灵或阿里云对口型协议。',422);
  if(adapter==='aliyun-lipsync'){
    // 额外允许 oss：只放 Bucket、地域与 AccessKey 末四位这类展示信息，真正的密钥在加密字段里。
    if(!config || typeof config!=='object' || Array.isArray(config) || Object.keys(config).some(k=>k!=='oss')) throw new AppError('INVALID_EXECUTOR','对口型渠道不需要执行器配置。',422);
    return config;
  }
  if(adapter==='kling'){
    if(!config || typeof config!=='object' || Array.isArray(config) || Object.keys(config).length) throw new AppError('INVALID_EXECUTOR','对口型渠道不需要执行器配置。',422);
    return config;
  }
  if(adapter==='volcengine-tts'){
    if(!config || typeof config!=='object' || Array.isArray(config) || Object.keys(config).some(k=>k!=='resourceId')) throw new AppError('INVALID_EXECUTOR','火山引擎语音渠道只能配置资源 ID。',422);
    if(config.resourceId!==undefined&&!VOLC_RESOURCES.includes(config.resourceId)) throw new AppError('INVALID_EXECUTOR','资源 ID 需为 seed-tts-2.0 或 seed-icl-2.0。',422);
    return config;
  }
  if(!config || typeof config!=='object' || Array.isArray(config) || Object.keys(config).some(k=>!['video','editTransport','videoBaseUrl','pointPrices'].includes(k))) throw new AppError('INVALID_EXECUTOR','执行器配置无效。',422);
  if(config.video && config.video!=='minimax-h3')throw new AppError('INVALID_EXECUTOR','视频执行器仅支持 MiniMax H3。',422);
  if(config.editTransport && !['multipart','json-data-url'].includes(config.editTransport))throw new AppError('INVALID_EXECUTOR','改图传输方式无效。',422);
  if(config.videoBaseUrl)normalizeBaseUrl(config.videoBaseUrl,'minimax-h3');
  if(config.pointPrices!==undefined){const prices=config.pointPrices;if(!prices||typeof prices!=='object'||Array.isArray(prices)||Object.entries(prices).some(([k,v])=>!['480P','768P','1080P','2K','4K'].includes(k)||typeof v!=='number'||!Number.isFinite(v)||v<0))throw new AppError('INVALID_EXECUTOR','积分单价需为分辨率到非负数字的映射。',422);}
  return config;
}
