# DSH 迁移与模型配置

> 2026-11-05 当前状态：统一记忆与按会话保存的近期历史保持。主人私聊及主人群内本轮直接@bot使用主人权限；后者仍读该群历史、回复本群，跳过群审核。群聊普通成员5%、主人20%概率接话，直接@不抽概率、不受冷却拦截。主人/主动12项工具，普通群聊/访客6项（四项表情工具、skill、draw_meme）。DSH直接加载表情技能制作GIF，不再为画表情调用Codex。下文旧的工具数、群无工具、记忆硬隔离等仅为历史记录。

> 2026-10-31 工具收缩更新：主人私聊及主动探索仅保留 pwsh、read、write、edit、web_search、web_fetch；复杂工作经终端派给全局 Codex CLI。群聊/访客仍无工具。Web Search Pro 保留作后端，B站工具从哈尔莫妮娅请求中移除；其他项目工具不变。操作见 [Codex派活.md](Codex派活.md)。下文基础迁移阶段的无工具/插件状态记录不代表当前状态。


更新：2026-10-31。统一后端已改为 DSH，当前等待你填写模型。

## 打开与填写

双击 `E:\QQbot\Harmonia\open-dsh.bat`。它会打开当前 DSH 进程的带认证入口；不需要 OpenAI/Codex 登录。单独访问 `http://127.0.0.1:3080` 时，若要求认证，使用此脚本重新打开。

在 DSH 的设置中完成两处配置：

1. 在模型提供商部分配置你的 API 提供商、API 地址、密钥和模型名。自定义兼容接口使用 `llm-pi-ai` 提供商配置；按提供商要求选择 Responses 或 Chat Completions 协议，并声明真实支持的推理等级和图片能力。
2. 在默认模型部分选择刚配置的提供商与模型（设置命名空间为 `agent-default-model`）。只增加提供商、但不改默认模型，哈尔莫妮娅仍会处于等待配置状态。

模型填好后，桥接最多约 30 秒检测一次，通常无需重启。检查：

```powershell
Invoke-RestMethod http://127.0.0.1:8080/health
```

预期 `brain=dsh`、`brainReady=true`、`qqConnected=true`、`wechat=polling`。`brainReady` 只表明默认模型已进入 DSH 可路由目录，不证明密钥正确；需真实发一条私聊验证推理。如果密钥、模型能力或协议错误，应在 DSH 控制台会话中查看具体失败。

模型未填写时，两端收到消息会告知需要配置，不会回退使用 Codex，也不会尝试以前的 API 密钥。

## 全局与项目范围

| 项目 | 位置/范围 |
|---|---|
| 全局 CLI | `%USERPROFILE%\AppData\Roaming\npm\dsh.cmd`，版本 0.2.1-rc.5 |
| 用户级 DSH HOME | `%USERPROFILE%\.dsh` |
| 全局 Web profile | `%USERPROFILE%\.dsh\profiles\web` |
| 模型与插件配置 | 该 profile 的 `cordis.patch.yml` 及 DSH 凭据存储，由 Web 设置界面管理 |
| 全局 DSH 静默启动 | `%USERPROFILE%\.dsh\Start-Web-Silent.ps1`，任务 `DSH-Web` |
| 全局打开控制台 | `%USERPROFILE%\.dsh\Open-Web.ps1` |
| 全局视频依赖 | `%USERPROFILE%\.dsh\bili-watch\deps` |
| 全局运行诊断 | `%USERPROFILE%\.dsh\.cache` |
| 哈尔莫妮娅应用状态 | `E:\QQbot\Harmonia\runtime`、`memory` |
| 哈尔莫妮娅唯一人设 | `E:\QQbot\Harmonia\config\PERSONA.md` |

DSH 可在其他目录通过 `dsh web` 或当前 Web 控制台使用，不在 QQbot 下再装第二份。DSH 本身按 profile 管理配置；本次统一使用用户级 `web` profile。将来若另建 `headless`/`desktop` profile，不应假设其模型配置会自动复制，需要在 DSH 中单独确认。

`standard`、`minimal`、`cordis` 等普通预设仍供其他项目使用。哈尔莫妮娅的人设与权限只安装在两个专属预设内，不写入全局通用人格，不影响其他项目的默认角色。

## 已安装的插件与依赖

- `@kanadego/dsh-heartbeat@2.0.1`：已安装到全局 Web profile，**当前停用**。全局 patch 中的 `heartbeat.disabled=true`；模型配置完成后再按调研计划设置绑定会话、发送限制及隐私范围后启用。当前没有启用桌面截图、心理画像或自动关怀。
- `dsh-bili-watch@0.3.9`：已安装，**按你的要求停用**，全局 patch 中 `dsh-bili-watch.disabled=true`。没有登录 B 站，没有启用评论、私信或主动刷视频。
- ffmpeg、ffprobe、yt-dlp：已安装到全局视频依赖目录；命令可启动。字幕、公开元数据、下载与抽帧有基础运行条件。
- ASR/OCR 的独立 Python 环境和 Whisper 模型属于可选重依赖，本次未安装；需要无字幕转写或画面 OCR 时可在插件设置页按需安装。
- `@harmonia/dsh-agent`：项目提供的薄预设插件，通过全局 profile 的 link 依赖引用 `Harmonia/plugins/dsh-agent`。它仅负责动态人设与权限，不实现另一套模型或聊天框架。

某些插件通过动态 import 使用宿主包，若另装一套宿主 peer 会产生缺依赖或多实例。已把 profile 内所需的第一方包链接到全局 DSH 安装的同版本包；`dsh plugin --profile web peers check` 已通过。升级全局 DSH 或插件后需要重新运行兼容检查与 `node scripts/verify-dsh.mjs`。

## 两端怎样共用大脑

`BRAIN_TYPE=dsh`，`DSH_URL=http://127.0.0.1:3080`。统一路由通过已安装 qq-bridge 的 DSH 鉴权/RPC 客户端连接常驻 DSH，并使用 rc.5 的 `remote.mux → session/follow` 收取完整回复，不调用一次性的 Codex CLI。

- 主人 QQ 和微信私聊共用一个 `owner-private` DSH 会话，预设为 `harmonia-owner`。
- 各群与其他获准私聊分别映射到不同 DSH 会话，使用 `harmonia-public`。
- 映射保存在 `runtime/dsh-sessions.json`，重启后继续复用。旧的 JSON 记忆与最近对话仍由应用注入，没有删除或搬到全局通用人设中。
- 人设在每次 DSH 组装提示词时动态读取；两端长期记忆规则、发送白名单及回执去重继续由桥接校验。
- 目前主人、群聊和访客预设的实际工具集合都为空。模型不能任意读取磁盘、运行命令、访问其他 DSH 会话或直接向群发消息。以后逐个启用扩展时，再同时调整插件开关及主人预设的 allowedTools。
- 修改 DSH 默认模型会在下一轮同步到对应会话，不需要为 QQ/微信各填一次。

专属会话在 DSH UI 中会显示“哈尔莫妮娅 · owner-private”等标题。可以查看轨迹；直接在这些会话里聊天时仍会遵循桥接的 JSON 输出格式，建议日常用 QQ/微信。其他工作新建普通会话即可。

## 自启与验证

`DSH-Web` 和 `Harmonia-Autostart` 均使用 wscript 无控制台入口，按用户登录触发并每两分钟检查。DSH 作为全局服务独立于 QQbot 管理；SnowLuma、小号账号及 iLink 登录未重置。

已验证：20 项本地测试通过；实际 DSH 进程连接本机假模型完成回复，基础模式主人与群聊都无工具，主人私聊标记未进入群聊，修改人设后系统提示立即更新。测试使用独立临时 DSH HOME，没有改动全局模型设置，也没有访问真实推理提供商。

当前缺少用户模型配置，所以尚未进行新后端的真实 QQ/微信推理、B 站内容理解或主动关怀验收。旧 Codex 代码暂保留作回滚，当前运行不会调用它。
