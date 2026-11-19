# 技术文档（technical）

记录“需求对齐之后已经实现”的技术方案：接口、数据、提示词、校验与验证。需求与取舍放在 `../requirements/`，部署与渠道配置放在 `../infrastructure/`；本目录只写实现本身，并随代码一起更新。

| 文档 | 内容 |
| --- | --- |
| [presenter-held-product-video.md](presenter-held-product-video.md) | 人物持物口播：手拿商品图、提示词预设、视频衔接、8 秒默认值 |
| [kling-channel.md](kling-channel.md) | 可灵渠道：AccessKey + SecretKey 存储与 JWT 签名；对口型调用 |
| [lipsync-providers.md](lipsync-providers.md) | 对口型两家对比（阿里云 VideoRetalk / 可灵）、计费与前置条件 |

约定：新的“对齐后实现”先在 `requirements/` 写差距与决策，落地后在本目录补一篇，并在 `docs/README.md` 与 `docs/STATUS.md` 登记。
