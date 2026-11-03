# 生图 / 生视频实现讲解

依据 2026-11-03 的代码阅读，重点是生视频。文件路径均相对仓库根目录。

## 1. 总体思路

生图和生视频走同一条链路，视频只是多了分镜规划、素材约束和成片拼接。

```
商品聊天 → 创作素材 → 项目画布(节点+连线) → 预览范围 → 点击开始
  → 冻结输入(run) → 提交供应商 → 轮询 → 下载结果 → 存为素材
  → 下游手选成功版本 → 再开始
```

要点：

- AI 只给建议，用户预览范围后点击「开始」才会花钱。
- 每次开始都会创建一条 run（表 `sj_creation_runs`），把提示词、参数、素材、模型、商品快照全部冻结进 `input`。之后改画布不影响已创建的 run。
- 下游节点引用的是上游某个具体成功版本，不会自动取最新。

## 2. 生视频：四个阶段

### 2.1 脚本与分镜规划

- 脚本由 planning 环节的默认文本模型生成（`creation-projects.mjs` 的脚本请求，`stage:'planning'`）。
- 分镜规划把「脚本 + 商品快照 + 素材清单」交给模型，要求输出 JSON：`shots[{title, description, videoMode, duration, prompt, materials, dialogue}]`。提示词在 `server/video-shot-plan.mjs` 的 `SHOT_PLANNING_SYSTEM`。
- 素材用 `M1、M2…` 编号交给模型，模型看不到 URL 和内部 ID，只能引用清单内编号，避免编造和泄露。
- 模型输出不可信，`sanitizeShotPlan` 逐条校验并修正，每处修正写入 `notes` 展示给用户：
  - 未知编号、类型与槽位不符、重复引用，直接丢弃。
  - 时长限制在 4–30 秒。
  - 违反方式规则时降级为文生视频并移除素材。
  - 提示词里 `{{M1}}` 标签只保留确实被本分镜引用的参考素材。
- 每个分镜同步成画布上的一个 `video` 节点（维度「视频分镜」）。分镜数据存在项目 JSONB 的 `storyboard`，修改需运营权限、CSRF 和 If-Match。

### 2.2 三种视频方式与素材规则

规则同时存在于三处，保持一致：分镜规划（`video-shot-plan.mjs`）、预览和执行前校验（`providers/creation-video.mjs` 的 `videoMediaIssue`）、常量（`shared/creation-video-parameters.mjs`）。

| 方式 | videoMode | 素材 | 限制 |
| --- | --- | --- | --- |
| 文生视频 | `text` | 无 | 不能连任何素材 |
| 首尾帧 | `frames` | 首帧 / 尾帧图片 | 各最多 1 张，至少 1 张，不能混用参考素材 |
| 参考素材 | `reference` | 参考图 / 视频 / 音频 | 图 ≤9、视频 ≤3、音频 ≤3，合计 ≤12；音频不能单独用，必须有图或视频 |

体积上限：图片 30 MB、视频 50 MB、音频 15 MB，单次请求 72 MB。时长 4–30 秒整数，分辨率 480P 到 4K，比例含 `adaptive`（自适应需要来源图片）。

### 2.3 提交与轮询（MiniMax H3，`server/providers/creation-video.mjs`）

提交 `submitVideo`：

1. 本地校验 `validateVideoGeneration`，不合格直接 422，没有发出任何请求。
2. 组装 `content` 数组：一个 `text`（提示词）加若干 `image_url / video_url / audio_url`，每项带 `role`（`first_frame`、`last_frame`、`reference_image`、`reference_video`、`reference_audio`）。素材以 base64 data URL 直接内嵌，因为服务端读字节上传，不假定供应商信任私有 MinIO。
3. `POST /minimax/v2/video_generation`，请求头带 `Idempotency-Key: requestKey`。响应只返回 `task_id`，视为 `queued`。

轮询 `pollVideo`：`GET /minimax/v2/query/video_generation/{id}`，取消用 `DELETE`。H3 状态映射：`scheduled` 和 `moderating` 算运行中，`blocked` 算失败并保留平台给出的审核原因（`CONTENT_BLOCKED`）。成功时从 `content.url` 下载视频，逐跳校验公网地址、体积和媒体签名。

台词通过 `dialoguePromptSuffix` 拼成提示词末尾的 `<d>[Chinese] 文本</d>` 段落，由模型做口型同步。

### 2.4 run 的状态机（`creation-projects.mjs` 约 560–650 行）

```
queued ──(本地校验)──► submitting ──► running ──► succeeded / failed / cancelled
```

关键安全设计：

- **先落库再发请求**：先把状态改成 `submitting`，再调用供应商。进程在这个边界崩溃，只会失败或轮询，绝不会重复提交。
- **PG 咨询锁**：`pg_advisory_unlock(hashtext('sj:creation:run:<id>'))` 保证同一 run 同一时刻只有一个处理者。
- **无上游编号的提交超时、5xx、响应丢失** 直接 `failed`（`SUBMIT_UNCONFIRMED`），用户一键重试；可能多计一次费用（ADR-0010）。
- **有上游编号** 则持续轮询，连续查询失败超 30 分钟才 `failed`（`POLL_FAILED`），起点记在 `output._pollFailSince`。
- **结果先暂存**：下载到字节后先写入 `output._pendingResult`，再存入素材库。素材保存失败时下一轮直接重试保存，不会再次请求供应商或重复计费。
- **取消**：立即落为 `cancelled`，即使上游取消接口出错，上游之后完成的结果也被忽略。
- 不自动重提、不自动换模型、不付费重试。

成功后结果通过 `media.put` 存为 `role:'result'` 的素材，立即可用。

## 3. 多分镜如何串起来

- **批量生成**：选最多 30 个分镜，先出批次预览（逐镜可执行性、预估积分、余额），再用唯一 `requestKey` 开始。同一 key 重复提交只会返回已有批次。
- **尾帧接力**：首尾帧方式的分镜可勾选「上一镜尾帧」。`shotDeps` 把它标记为依赖上一镜，批次里显示「等待上一镜」。上一镜成功后用 `frameExtractor` 抽出最后一帧，作为下一镜的首帧。这样相邻镜头画面连续。
- **成片拼接**（`server/video-compile.mjs`）：全部分镜成功后，服务端 ffmpeg 合成一个 MP4，不调用模型，不产生供应商费用。
  1. 每镜写入临时目录，`ffprobe` 读取尺寸、帧率、时长、是否有音轨。
  2. `buildCompileArgs`（纯函数，便于测试）：尺寸和帧率取第一镜；每镜缩放加黑边填充到统一尺寸；有音轨的镜头统一为 48 kHz 立体声；无音轨的用 `anullsrc` 补同样时长的静音；用 `concat` 滤镜按顺序拼接，镜头之间不加转场；输出 H.264 + AAC，`+faststart`。
  3. 字幕：各镜字幕按实际时长平移到成片时间轴，生成 SRT。勾选烧录时再跑一遍 ffmpeg 烧入，缺中文字体或烧录失败则整体失败，不返回半成品。
  4. 成片不得超过 100 MB（素材库单文件上限）。
  5. 结果归集为结果素材，失败时保留原分镜，临时目录无论成败都会删除。
- **后期配音**：`dubMode==='post'` 时，视频成功后再混音为派生视频；混音失败不影响原视频的成功状态。

## 4. 生图简述

以下来自 `AGENTS.md`，未逐行读执行器代码。

- 执行器：OMYAI 与 OpenAI 兼容图片接口；`server/providers/creation-image.mjs`。
- 节点类型：商品输入、图片输入、提示词、生图、改图、合成、视频、输出。连线按 text / image / video 类型校验。
- 合成节点在浏览器内拼图并上传结果，不调用模型。
- 生图复用第 2.4 节同一套 run 状态机和幂等规则。

## 5. 验证边界

- H3 视频执行器只做了协议 fixture 验证，没有真实付费调用，不能视作真实供应商验收。
- 拼接部分的 ffmpeg 调用通过注入 `spawnFn` 测试，不依赖真实 ffmpeg。
