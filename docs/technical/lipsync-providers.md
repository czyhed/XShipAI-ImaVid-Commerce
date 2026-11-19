# 对口型 Provider：阿里云百炼 VideoRetalk 与可灵

日期：2026-11-18。目标：底片和手/商品不动，只按配音重画嘴部。

## 为什么不用 MiniMax H3 做对口型

H3 的作用是生成底片（文生 / 首帧 / 参考素材）。它也能“跟着音频说话”，但方式是把整段画面按音频重绘，手和商品会跟着漂移，这不是只改嘴。对口型必须换一个专门的模型。

## 两家对比（2026-11-18）

| 项 | 阿里云百炼 VideoRetalk | 可灵 Advanced Lip Sync |
| --- | --- | --- |
| 计费 | **约 ¥0.08/秒，按生成时长后付费**，无资源包门槛；有 1800 秒免费额度 | 约 0.5 积分 / 5 秒（≈¥0.1/秒）；开放平台需先买资源包（5000 积分起，180 天有效） |
| 8 秒单条口径 | ≈¥0.64 | ≈¥0.8（另需套餐投入） |
| 视频输入 | 公网 URL，MP4/AVI/MOV ≤300MB，2–120 秒 | 公网 URL，MP4/MOV ≤100MB，2–60 秒 |
| 音频输入 | 公网 URL，WAV/MP3/AAC ≤30MB，2–120 秒 | URL 或 Base64，MP3/WAV/M4A ≤5MB，2–60 秒 |
| 区域 | 仅华北2（北京），北京区域 API Key | 北京节点 |
| 并发 | 提交 1 RPS、同时 1 个任务 | 以控制台为准 |
| 平台适配 | `adapter=aliyun-lipsync`，固定 `https://dashscope.aliyuncs.com` | `adapter=kling`，固定 `https://api-beijing.klingai.com` |
| 现状 | 已接入；设为默认时优先 | 已接入，作为备选 |

结论：默认用阿里云。它按秒后付费、没有套餐门槛，价格更低，2–120 秒也覆盖 8 秒底片；可灵保留为备选，随时在「模型中心 → 环节默认 → 对口型」切换。

## 平台用法

1. 模型中心新增渠道：协议选「阿里云百炼对口型（VideoRetalk）」，填百炼 API Key（DashScope，北京区域）。
2. 「环节默认 → 对口型」选中该渠道（新增时若为空会自动指向）。
3. 分镜先生成视频、再合成配音；在「本镜预览」点「只改嘴（可灵/阿里云）」。
4. 结果保存为新素材（`derivedFrom.kind='presenter-lipsync'`），原视频与配音保留。

## 阿里云 VideoRetalk 交互细节

### 一次「只改嘴」请求实际发生什么

前提是分镜已有成功的视频底片，并且当前台词对应的 TTS 配音已合成。点击「只改嘴」后，服务端按下列顺序处理：

1. **读取平台私有素材。** 服务端从 MinIO 读取底片视频与配音音频字节；不会把 MinIO 密钥或私有桶地址交给浏览器。
2. **生成临时 HTTPS 链接。** 对底片与配音各生成一个 HMAC 签名链接，默认有效 1 小时，链接绑定素材编号、工作空间与过期时间。地址使用 `SJ_MEDIA_PUBLIC_ORIGIN`，签名由 `SJ_MEDIA_SIGNING_KEY` 生成。只有拿到完整链接的人可在有效期内访问对应素材。
3. **向阿里云提交异步任务。** 服务端向固定北京地址 `https://dashscope.aliyuncs.com/api/v1/services/aigc/image2video/video-synthesis` 发送 `model: "videoretalk"`、`video_url`、`audio_url` 和 `X-DashScope-Async: enable`。百炼 API Key 放在 HTTPS Authorization 请求头，不进入 URL、浏览器或任务链接。
4. **阿里云取走素材并处理。** 阿里云服务端访问上述两个临时链接，读取底片和音频后执行口型替换。该链路会把这两份素材发送到阿里云百炼；它们包含画面中人物、商品、背景与配音内容。平台不会发送项目其他素材或整份 MinIO 桶。
5. **保存异步任务状态。** 平台只在项目任务数据里保存供应商任务 ID、渠道 ID、源视频 / 音频素材 ID、提交时间和状态，不保存 Key，也不保存签名 URL。
6. **轮询任务。** 页面每 6 秒请求平台状态接口；平台服务端用 API Key 查询 `/api/v1/tasks/{task_id}`。轮询持续到成功或失败，前端最多自动轮询约 4 分钟；超时只停止前端自动查询，任务仍可能在供应商侧继续。页面目前没有单独的“继续查询”按钮；不要再次点击提交按钮来刷新状态，以免创建第二个付费任务。
7. **下载并归档结果。** 成功后平台服务端从阿里云返回的 HTTPS 结果地址下载 MP4，保存回项目私有 MinIO，生成新的结果素材 `derivedFrom.kind='presenter-lipsync'`。原 H3 底片和配音都保留，不覆盖；平台不会把阿里云结果公开给其他用户。

### URL 与访问边界

- 媒体链接本身是短期 bearer capability：持有链接即可读取对应素材，直到过期。不要把它粘贴到聊天、工单或公开日志。
- 链接有效期 1 小时，给异步队列留余量；过期后阿里云无法再取源素材。签名验证限制最长有效期，过期链接返回 403。
- A 记录、TLS 证书和 Nginx 18445 入口只提供经过签名校验的媒体路由；不公开 MinIO 服务、不公开普通素材文件路由。
- 操作有费用：每次创建对口型任务都会向百炼提交一次，按供应商计费规则结算。状态查询不创建新任务，不应重复点「只改嘴」来刷新状态。
- 失败时平台保存失败状态与简化错误；不会自动重复提交、切换供应商或再次付费。用户确认后才可手动重试。

### 开通与凭据

1. 登录 [阿里云百炼控制台](https://bailian.console.aliyun.com/)，在 API-KEY 管理创建北京地域的 DashScope Key。
2. 在模型中心添加「阿里云百炼对口型（VideoRetalk）」渠道；平台固定北京 API 地址，Key 加密保存。
3. 在「环节默认 → 对口型」将此渠道设为默认。
4. 先生成 H3 底片，再合成配音，最后点击「只改嘴」。

## OSS 中转（2026-11-19 起，推荐）

线上实测：阿里云抓取程序访问 `https://sj.chenzy-ai-project.icu:18445/...` 返回 `Connection ... refused`；把同一域名挂到标准 443 后，云防火墙只放行 18300–18445，外网 443 仍不可达。结论是平台服务器不适合作为外传入口。

因此对口型渠道支持可选的 OSS 中转：

1. 模型中心 → 阿里云对口型渠道 → 编辑 → 展开「OSS 中转」，填 Bucket、地域（如 `oss-cn-beijing`）、一对 AccessKey ID / Secret。
2. 提交「只改嘴」时，平台把底片和配音两个文件上传到该 Bucket 的 `shangjing/lipsync/<日期>/<随机编号>.<扩展名>`，再用 1 小时有效的 OSS 签名链接交给 VideoRetalk。
3. 桶保持私有，不开启公共读；链接绑定对象与到期时间。平台只上传本次这两个文件。
4. 没填 OSS 时回退到平台签名链接，需要服务器对公网开放标准 443。

配置错误在保存渠道时就拒绝（四项必须同时填齐、格式校验）；上传失败返回 `OSS_UPLOAD_FAILED`（HTTP 状态码随错误说明）。AccessKey 与 DashScope Key 一起 AES-256-GCM 加密保存，列表只显示末四位。

**403 怎么读：** 上传失败时错误信息会带上 OSS 返回的 `<Code>`，例如 `AccessDenied`（RAM 用户没有该 Bucket 权限）、`InvalidAccessKeyId`（Key 已停用）、`SignatureDoesNotMatch`（Secret 不匹配）、`NoSuchBucket`（Bucket 名或地域不对）；若 Bucket 在别的地域，还会附带「该 Bucket 实际地域为 oss-cn-xxx」。

**RAM 权限必须同时给读写两项：** 预签名链接的权限跟随签名用的 AccessKey，所以只有 `oss:PutObject` 时上传会成功、阿里云下载会拿到 403。最小权限策略示例：

```json
{
  "Version": "1",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["oss:PutObject", "oss:GetObject"],
    "Resource": ["acs:oss:*:*:<你的Bucket>/shangjing/*"]
  }]
}
```

**签名（V1）**：`StringToSign = VERB\nContent-MD5\nContent-Type\nDate|Expires\nCanonicalizedOSSHeaders + CanonicalizedResource`。`CanonicalizedOSSHeaders` 每条自带结尾换行，没有 `x-oss-*` 头时为空 —— 因此 `Date` / `Expires` 与资源路径之间只有**一个**换行；多一个空行、少一个换行都会得到 `SignatureDoesNotMatch`（2026-11-19 线上真实踩过）。

**保存后不需要反复输入：** 非敏感的 Bucket、地域和 AccessKey 末四位存在渠道的展示配置里，再次编辑时回填并显示「已保存 OSS：…」；AccessKey ID / Secret 两个输入框留空即沿用已保存的值，只改其中一项也可以（服务端按字段合并）。想彻底删掉中转配置，勾选「清除已保存的 OSS 配置」后保存。

运营侧建议：给这对 AccessKey 单独建一个 RAM 用户，只授予该 Bucket 的 `oss:PutObject`；桶上配一条 1 天过期的生命周期规则自动清理中转文件。

## 共同前置条件

- `SJ_MEDIA_PUBLIC_ORIGIN` 配置为 `https://sj.chenzy-ai-project.icu:18445`；`SJ_MEDIA_SIGNING_KEY` 是服务端随机生成的 48 字节以上密钥，两者只进入服务器和 shangjing 容器配置。2026-11-19 已在线上实例配置并重启生效。
- DNS A 记录已解析到 `110.42.51.234`；Let's Encrypt 证书签发并安装，公网上 HTTPS/TLS 验证成功。
- 还需用户在模型中心配置北京地域的百炼 API Key。

### 签名链接为什么能免登录

18445 的 Nginx vhost 直连 `127.0.0.1:18307`（容器 4173），不经 18306 网关。18306 网关对每个请求都做 `auth_request`，没有会话就 303 跳登录页，而阿里云服务器没有登录态，会被直接挡掉。应用侧 `server/http.mjs` 对 `GET /api/creation/media/:id/public` 放行会话检查，由路由用 HMAC 签名校验（素材编号 + 工作空间 + 过期时间）；无签名或签名不符返回 403 `INVALID_MEDIA_SIGNATURE`。

验证方式：用假签名请求该路径，返回 403 即说明直达应用；若返回 303 说明又被网关接管。2026-11-19 线上实测 `403 INVALID_MEDIA_SIGNATURE`。

## 验证

`tests/aliyun-lipsync.test.mjs`、`tests/creation-lipsync.test.mjs`、`tests/kling-channel.test.mjs`、`tests/oss-transfer.test.mjs`：请求体、异步头、状态映射、结果下载、OSS 签名与上传、固定地址与协议校验。

2026-11-19 线上真实调用已跑通完整链路：上传底片与配音到用户 OSS → 提交 VideoRetalk 异步任务 → 轮询 → 下载结果（结果地址 http 升级 https）→ 归档为新素材。可灵仍未做真实调用。
