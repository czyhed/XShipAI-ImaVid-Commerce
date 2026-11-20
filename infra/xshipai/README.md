# XShipAI 测试工作台部署

2026-10-31：源仓库 agent-project 的 main（运行代码 `fc150c6`）及 `feat/project-ai-workflow` 分支同步至私有仓库 `xshipai/agent-project`，保留 Git 历史。原仓库不变；这是独立副本，后续同步需显式拉取 upstream 并合并，不是定时镜像。

入口为 http://23.144.68.140:18180/，登录后点击 **商境**。18186 为受保护的应用入口，未登录或未从工作台启动均跳回桌面。账号密码和飞书规则沿用 XShipAI Desktop。商境容器内部 `SJ_AUTH=off` 使用共享测试空间；认证由外层网关负责，应用、数据库、素材存储均不发布宿主端口。不要给这些服务单独映射公网端口。

## 数据和配置

- 部署根目录 `/opt/xshipai-test`；源码 `sources/shangjing`；镜像 `xshipai/shangjing:fc150c6`。
- 专用 `shangjing-db`（PostgreSQL 17）与 `shangjing-objects`（MinIO），命名卷 `xshipai-test_shangjing-db` / `xshipai-test_shangjing-objects`。不连接旧服务器的业务库，也不清理其他应用。
- 内部连接校验 TLS；证书及 CA 在 `config/shangjing-tls`。叶证书有效期 825 天，届时须换证；CA 有效期 10 年。
- `config/shangjing.env` / `shangjing.private.json` 保存凭据与渠道加密主密钥，权限 600。备份数据时须同时安全保存配置、主密钥和证书；不要提交 Git。
- 初次部署配置的 `qwen3.8-flash` 文本和 `gpt-image-2-special` 生图渠道保留。2026-10-31 按用户要求又从旧站复制了全部 4 个活动模型渠道、6 条模型目录与 5 个环节默认设置；默认选择现在与旧站一致，见下节。本次没有提交付费生成。
- 已创建“XShipAI 示例保温杯”、“保温杯内容创作 · 示例”和“部署测试色卡（非商品图片）”，数据持久化，不冒充真实商品素材。

## 安装与更新

### 旧站模型配置复制（2026-10-31）

来源 `https://191.40.44.254:8443`，原 `shangjing-app` 保持运行，不删除、不重启、不修改。已复制 OMYAI、DeepSeek、MiniMax H3 和火山语音四个渠道，包含接口地址、密钥、执行器参数、模型能力、启停 / 可用状态及手工目录标记。原站 6 条模型目录全部保留（包括禁用项），没有自动启用模型或发起目录同步。

五项默认选择：商品 / 规划 `deepseek-flash`，生图 `gpt-image-2.5-flare`，视频 `MiniMax-H3`，语音为原火山语音渠道。已有 XShipAI 两个渠道作为额外配置保留；不再作为默认。商品、项目、素材及旧站业务数据没有搬迁或删除。

通过 SSH 在内存传输配置，API Key 用目标环境现有主密钥重新加密，未落到本机明文文件或 Git。导入前备份位于目标服务器 `/opt/xshipai-test/backups/model-copy-20261031-112159`，含数据库归档及目标私密配置。事务导入完成后，逐项比较了可解密凭据、执行器参数、模型目录和默认项；重新读取源配置确认未变化，新站认证后的模型目录及基础 API 验证通过。未提交真实付费生成，不能据此宣称供应商余额或视频 / 语音生成已验收。

### 常规部署

先将精确提交导出到服务器源码目录，再执行：

```sh
cd /opt/xshipai-test
docker build -f sources/shangjing/infra/app/Dockerfile -t xshipai/shangjing:<commit> sources/shangjing
APP_IMAGE_TAG=<commit> python3 sources/shangjing/infra/xshipai/install.py
python3 sources/shangjing/infra/xshipai/bootstrap.py
# XShipAI Desktop 仓库必须包含 shangjing 图标与 18186 网关规则。
docker build -t xshipai/desktop:1.0.0 sources/xshipai-desktop
python3 sources/xshipai-desktop/deploy/install.py
# DESKTOP_PASSWORD 由维护者的私密环境注入。
python3 sources/xshipai-desktop/deploy/verify.py
python3 sources/shangjing/infra/xshipai/verify.py
```

安装脚本备份 compose 与网关到 `backups/shangjing-*`，保留已有数据卷和凭据；更新前另做数据库与对象备份。旧 `prepare-stack.py` 不适用于桌面网关，禁止用它覆盖配置。回滚应用时将 compose 中商境镜像改回已验证版本，仅更新商境服务，不执行 `down -v`。

## 本次验证

- 精确源码镜像完成 Vite 构建，396 项现有测试全部通过，语法 / JSX 构建通过。测试使用独立临时 PostgreSQL，不连接业务库。Windows 本机 Docker 未启动，因此数据库相关测试改在服务器隔离容器运行。
- 六个应用均通过未登录拒绝、登录但未启动拒绝、启动后页面/API 可访问、退出后撤销测试。
- 商境概览、商品、项目、素材和模型目录读取通过；缺 CSRF / 错误 Origin 写入拒绝；私有素材上传、读取、Range 下载及退出后拒绝通过。
- 独立浏览器验收通过六图标、商境概览 / 商品 / 项目画布 / 素材 / 模型目录、搜索、已有 PicAgent 回归和退出拦截；新增第六图标导致的窄屏 Dock 溢出已修复，375px / 320px 复验通过。
- 商境重启后，同一示例项目与测试素材仍可读取。桌面 iframe 自动验收被浏览器工具的 paused document response 限制阻断，不能据此宣称内嵌显示已验证；授权后的独立页面验证通过，可用窗口右上角“新标签页”入口。不将夹具或页面验证当成真实供应商生成验收。
# 2026-11-01 图片 Logo 更新

商境页面、登录页和 favicon 使用 `web/public/logo.png`，XShipAI 桌面使用同一图片副本。应用代码提交 `242a378`；镜像 `xshipai/shangjing:logos-20261101`，原镜像 `xshipai/shangjing:fc150c6` 保留回退。构建及容器内 PNG 响应检查通过，SHA-256 为 `60c682db53e273c502ab96eaa65a96eba61630f460561c6d8c4e054a82b7a08f`。

七个项目本次更新的 compose/镜像备份位于 `/opt/xshipai-test/backups/logos-20261101-102514`，部署清单为 `/opt/xshipai-test/logos-deployment.json`。仅重建应用容器并刷新网关；不运行迁移、不更改数据库和渠道、不启动付费生成。商境回退时仅恢复其旧镜像并重建该服务，随后刷新网关。
