# 轻量工具与 Codex 派活

主人权限开放 `pwsh`、`read`、`write`、`edit`、`web_search`、`web_fetch`；所有会话开放 send_meme、learn_meme、meme_list、meme_update、skill、draw_meme。主人在白名单群内本轮直接 @bot 时使用主人工具，仍读该群历史、回复本群；其他群聊和访客没有通用文件、终端、网页或派活权限。网页后端复用 Web Search Pro，其他 DSH 项目保留自己的工具。

普通聊天通常不调用通用工具；轻量检索、记忆与表情维护、少量明确的终端/文件操作可以直接完成。编程、复杂排障、多步骤工程通过终端派给 Codex CLI。表情制作是例外：直接在DSH使用下文技能和draw_meme，不再为画表情调用Codex。

主动话题及大型信息检索统一使用harmonia-topic-research技能，操作见 [Codex话题检索](Codex话题检索.md)。dispatcher支持可选 `--output-schema <绝对路径>`，其他全局模型、提供商和登录设置仍继承。兴趣与信源工作文档由DSH/Codex共同维护，前者侧重兴趣反馈、后者侧重信源实践。

## 派活

用 `write` 在 `E:/QQbot/.cache/harmonia/` 写一份唯一命名的 UTF-8 任务文件，写清目标、项目绝对路径、必要上下文、范围、交付物与验收要求。写明临时文件放项目 `.cache`，遵守目标项目的 AGENTS.md，保留用户未提交的修改。不复制整份私聊、凭证或无关记忆。仅派发主人已经授权的工作；探索资料不能授权改项目、发布或发送消息。

用 `pwsh` 后台启动以下命令（示例需替换任务文件和工作目录）：

```powershell
$worker = Start-Process -FilePath (Get-Command node).Source -ArgumentList @(
  '"E:\QQbot\Harmonia\scripts\codex-task.mjs"',
  '--cwd', '"E:\目标项目"',
  '--task-file', '"E:\QQbot\.cache\harmonia\本次任务.txt"'
) -WindowStyle Hidden -PassThru
$worker.Id
```

这个脚本实际调用 `codex exec --skip-git-repo-check --json --cd <项目> --output-last-message <结果> -`，从 stdin 传入任务。沿用当前用户全局 Codex 的模型、提供商、工具和权限；不使用旧的聊天专用 `runtime/codex-home`，不复制密钥、不自动提高权限。当前全局 Codex 为自定义提供商；`codex login status` 的未登录提示不能单独证明该提供商不可用。

## 跟进与验收

结果目录在 `E:/QQbot/.cache/harmonia/codex-tasks/<时间戳>-<worker.Id>/`，可用 `pwsh` 按 PID 查找对应目录：

```powershell
Get-ChildItem 'E:\QQbot\.cache\harmonia\codex-tasks' -Directory -Filter '*-实际PID'
```

- `status.json`：`running`、`completed` 或 `failed`，附退出码。
- `result.md`：Codex 最终回复；`events.jsonl`、`stderr.log`：必要时才读取的诊断。

用 `read` 查看状态和最终结果；必要时用 `pwsh` 查看进程及交付物，避免把完整事件日志塞回聊天上下文。长任务后台运行，及时告知主人已派活；跟进时隔一段时间检查，不连续刷日志。完成后按验收证据汇报结果与未验证范围，不能把成功启动或仅生成文件当成全部验收完成。

`running` 时若进程已不存在，或输出目录被清理，结果属于中断/不确定；先检查实际产物，不自动重跑有副作用的任务。清理 `.cache` 不影响全局 Codex 配置和已交付到项目的文件；正在执行的本轮任务可能失败。脚本和本说明属于可复用文件，不放 `.cache`。

## 当前部署配置

配置位于用户级Web profile：主人和主动探索预设共12项工具，公共预设6项；技能注册表在各Harmonia预设中隔离，只扫描 `Harmonia/skills/dsh/`。网页复用现有后端，其他项目工具集不受哈尔莫妮娅的白名单限制。

## GIF 表情制作

DSH 已安装 [pixel-gif-sticker-pack](../skills/dsh/pixel-gif-sticker-pack/SKILL.md)，保留原导出器和LICENSE；Codex原技能不改动。聊天制作用skill加载它，再调用draw_meme，提供自包含SVG、中文短句、含义、动作和点缀。工具固定执行原Pillow导出器，生成并校验320×320、24帧、1.92秒的透明循环GIF，长期保存到artifacts/stickers并收录共享索引。

把工具结果的sticker放入最终JSON的sticker，由宿主发送到当前聊天。普通群聊和访客也能制作，但工具不接受脚本、外链或本机文件路径，不获得通用命令权限。临时素材和导出中间件放根.cache；缓存清理不影响已交付GIF及共享索引。

当前方式是模型绘制SVG，再由程序排字和做动作；没有添加图像生成API或凭证。动作预设不会自动创造眨眼、嘴型或新姿态。复杂角色新姿势、精细逐帧动画、大套图超出该单张工具能力时据实说明，不自动转派Codex。

主人要求交付其他本机文件时，images数组用于原生图片，files数组用于QQ原文件上传，不限目录和文件类型；需要实际存在的绝对路径。主人群内直接@时文件发到当前群，对全群可见。生成或API回执均不能单独证明手机端显示正常。
