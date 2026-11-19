# 可灵（Kling）渠道

日期：2026-11-18。可灵通过 HTTP API 调用，鉴权是 AccessKey + SecretKey 现签 JWT，不是单个 API Key。

## 已实现

- 协议 `adapter=kling`，白名单在 `server/channels.mjs` 的 `validateProtocol`；不接受执行器配置。
- Base URL 固定为 `https://api-beijing.klingai.com`（`normalizeBaseUrl` 忽略传入值），避免签名令牌被发往他处。
- 凭据：模型中心表单两个输入框；服务端用 `channelSecret` 合并成 `accessKey:secretKey`，仍走原有 AES-256-GCM 加密列，列表只显示末四位。两段只允许字母、数字、`_`、`-`，各 8–200 位。
- 编辑渠道时需要同时重填 AccessKey 与 SecretKey（只填一项会被拒绝）；都不填则保留原密钥。
- 签名：`server/providers/kling-auth.mjs` 的 `klingJwt`，HS256，`iss=AccessKey`，`exp=now+1800`，`nbf=now-5`。
- 模型目录：可灵没有目录，不同步；`executorCapabilities` 返回空，不会被文本 / 生图 / 视频环节选中。

## 对口型执行器（已接入）

链路：`server/providers/creation-lipsync.mjs`

1. `POST /v1/videos/identify-face`：传 `video_url`（**必须是供应商可访问的公网 HTTPS 地址**；可灵没有文件上传接口），返回 `session_id` 与 `face_data[]`。底片要求 MP4/MOV、2–60 秒、≤100 MB、720P/1080P、边长 512–2160。
2. `POST /v1/videos/advanced-lip-sync`：`face_choose` 只能一项；音频用 `sound_file` 内联 Base64（MP3/WAV/M4A，≤5 MB，2–60 秒）；固定 `watermark_info.enabled=true`。
3. `GET /v1/videos/advanced-lip-sync/{task_id}` 轮询；状态 `submitted`/`processing`/`succeed`/`failed`，成功后下载 MP4。

平台接线：

- 模型中心「环节默认」新增「对口型」，只列出启用中的可灵渠道；新增可灵渠道时若尚无默认会自动指向它。
- 分镜「本镜预览」新增「只改嘴（可灵）」：要求本镜已有成功视频且配音为最新；提交后每 6 秒轮询，结果保存为新素材（`derivedFrom.kind='presenter-lipsync'`），不改原视频、不重提。
- 视频用既有签名临时媒体链接交给可灵（`SJ_MEDIA_PUBLIC_ORIGIN` + `SJ_MEDIA_SIGNING_KEY`，5 分钟有效）；未配置时返回 `PUBLIC_MEDIA_UNAVAILABLE`，提示先配置可信公开 HTTPS 媒体地址。
- 多张人脸时返回 `LIPSYNC_FACE_CHOICE` 并列出候选，不会自动选人。

## 待验证

- 官方文档域名在本机网络无法直接打开，字段以可灵文档的第三方镜像与多份接入实现交叉核对；首次真实调用前请用一条 8 秒底片确认参数。
- 线上实例当前没有公开 HTTPS 媒体地址（`PUBLIC_HOST` 是 IP），需配置域名后才能调用对口型。

## 验证

`tests/kling-channel.test.mjs`：密钥打包 / 拆包、JWT 头 / 载荷 / 签名、固定地址与协议校验。未连接可灵服务。
