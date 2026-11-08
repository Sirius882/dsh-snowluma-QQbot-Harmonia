# 哈尔莫妮娅 Harmonia

基于dsh和sl的qq bot。人设是《鸣潮》的达妮娅。主要价值是对基础软件和现有插件的一些改动，以及一份人设文档。

项目以 QQ 为主要使用场景，同时保留微信 iLink 接入。角色网名为「哈尔莫妮娅」，运行人设来自《鸣潮》的达妮娅。本仓库提供桥接程序、DSH 专属插件、上游适配补丁、算法与提示词，以及可自行修改的脱敏人设模板。

## 主要实现

| 内容 | 入口 |
| --- | --- |
| 单一长期记忆、来源记录、自主增删改与快照／增量提示缓存 | `Harmonia/lib/store.mjs`、`memory-view.mjs`、`brain/unified-router.mjs` |
| 四天／50条近期聊天窗口、批量裁剪、管理员 `/reset`、DSH 历史重放控制 | `Harmonia/lib/history.mjs`、`reset.mjs`、`plugins/dsh-agent/history-window.mjs` |
| 主人／群聊权限、Terra 一次性群聊审核、前7条原生群历史 | `Harmonia/brain/moderation.mjs`、`plugins/dsh-agent/index.mjs` |
| dsh-alive 主动陪伴、AI 状态评估、内存傲娇状态与话题续接 | `Harmonia/plugins/dsh-agent/alive*.mjs`、`Harmonia/lib/tsundere.mjs` |
| 共享 SQLite 表情库、原生图片／文件投递、合并转发与动图理解 | `Harmonia/adapters/`、`Harmonia/lib/stickers.mjs`、`media.mjs` |
| DSH 直接制作 GIF 表情、复用原导出器 | `Harmonia/lib/draw-meme.mjs`、`Harmonia/skills/dsh/` |
| Codex 工程派活及带来源的话题检索 | `Harmonia/scripts/codex-task.mjs`、`Harmonia/lib/topic-research.mjs` |
| 普通文字回复、可选内部元数据、完整字段恢复、投递去重 | `Harmonia/lib/reply-json.mjs`、`delivery.mjs` |
| SnowLuma 隐藏窗口、登录恢复、alive／meme 补丁及原始 HTTP 抓取 | `Harmonia/scripts/patch-*.mjs`、`capture-dsh.mjs` |

人设模板在 [Harmonia/config/PERSONA.example.md](Harmonia/config/PERSONA.example.md)。角色的个性、互动方式与记忆管理提示词可以公开复用；真实记忆没有随仓库发布。

## 环境与配置

当前实现面向 Windows，使用 Node.js 24.14+、PowerShell、已安装并登录的 QQ、全局 DSH Web；部分媒体和派活功能还需要 FFmpeg、Python/Pillow 与 Codex CLI。DSH 的模型、提供商和凭证沿用使用者自己的全局 profile，不包含在仓库中。

首次配置前，在项目根目录执行：

```powershell
Copy-Item Harmonia/config/.env.example Harmonia/config/.env
Copy-Item Harmonia/config/PERSONA.example.md Harmonia/config/PERSONA.md
```

在本地 `.env` 填写自己的主人 QQ、机器人 QQ、白名单与随机访问令牌；空白名单不会开放访问。`PERSONA.md` 是唯一生效的人设，可以在本地修改，已被 Git 忽略。不要将个人身份、聊天记录或密钥写回公开模板。

上游来源和已验证版本见 [vendor-sources.json](Harmonia/vendor-sources.json)，安装及适配入口为 `Harmonia/scripts/install.ps1`、`install-features.ps1`。这些脚本沿用已有的全局 DSH profile 和本机 QQ 环境，**不是空白机器的一键部署器**；其中基础仓库克隆不会自动检出清单中的固定提交，首次部署应核对版本。先阅读 [DSH迁移与模型配置](Harmonia/docs/DSH迁移与模型配置.md)、[启动关停与超时处理](Harmonia/docs/启动关停与超时处理.md) 和 [静默自启说明](Harmonia/docs/静默自启说明.md)，再按自己的环境配置。部分技能和操作文档仍使用 `E:/QQbot` 示例路径。

已配置环境通过根目录 `start-all.bat`、`stop-all.bat`、`restart-all.bat` 管理服务。DSH 为共享服务，重启会影响使用同一服务的其他项目。

## 隐私与公开边界

公开内容包括源码、算法、系统提示词、测试、插件补丁、安装／迁移脚本、技术设计文档和脱敏人设模板。`Harmonia/memory/` 中的实际记忆及旧归档、`research/` 私人笔记、`runtime/` 会话与登录状态、`chatlog/` 原始请求、`.env`、表情收藏、生成附件、人设副本、私有示例与旧人设均不公开。

`.gitignore` 已覆盖这些数据目录；只在源码与测试中使用合成账号。首次公开版本以干净快照接续远端许可证提交，不携带本机的历史开发提交。后续提交前仍应检查暂存区；忽略规则无法清理已经提交过的历史，也不能识别任意源码中后来写入的私人内容。

## 验证与来源

在 `Harmonia/` 目录执行 `npm test`。`npm run test:dsh` 依赖已配置的真实 DSH 及上游依赖，通过隔离环境和本机假模型验证集成；`npm run check` 检查当前部署状态。旧的本地验收记录见 [VALIDATION.md](Harmonia/VALIDATION.md)，不代表新环境已完成收发验收。

本仓库采用 [AGPL-3.0](LICENSE)。上游 DSH、SnowLuma、dsh-alive、dsh-meme 等项目的来源见版本清单；依赖安装时保留各自许可证。随仓库复用的 GIF 导出器另附其原始 MIT 许可证。达妮娅及《鸣潮》相关角色、美术与台词归各自权利方所有，项目代码许可证不代表获得这些内容的权利。
