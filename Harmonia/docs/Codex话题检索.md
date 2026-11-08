# Codex话题检索

普通聊天主要使用人设、记忆快照/增量、近期上下文和少量工具；单页轻量查询可用DSH网页工具。需要主动开场话题检索，以及模型判断需要多信源调查、深入阅读或专用工具的大型检索时，经现有CLI派活入口执行 `$harmonia-topic-research`。DSH不重复进行同一轮大型检索。纯关怀和情侣闲聊不需要先查新闻或凑候选，sources可以为空。

DSH主要维护 `E:/QQbot/Harmonia/research/INTERESTS.md` 中的兴趣和反馈；Codex主要维护 `SOURCES.md` 中各信源的访问经验、质量与入口。双方都可以读写两份工作笔记。它们不是第二份角色卡或隔离记忆，不整份塞进每次闲聊提示；需要时读取。

## 提交

先读Codex派活.md。用write在根.cache/harmonia写UTF-8任务文件，内容可直接采用：

```text
使用 $harmonia-topic-research，技能入口 E:/QQbot/Harmonia/skills/harmonia-topic-research/SKILL.md。
为哈尔莫妮娅这次主动开场检索3到5个候选，先自行读取研究目录的兴趣和信源笔记，实际搜索并打开资料，维护信源使用经验。只返回技能约定JSON，不发聊天消息，不编写最终开场白。没有足够材料时如实返回insufficient。
```

如有本轮明确话题或已聊过的主题，补一两句必要约束，不复制完整聊天、秘密或无关记忆。通过pwsh后台启动现有dispatcher，增加输出schema：

```powershell
$worker = Start-Process -FilePath (Get-Command node).Source -ArgumentList @(
  '"E:\QQbot\Harmonia\scripts\codex-task.mjs"', '--cwd', '"E:\QQbot"',
  '--task-file', '"E:\QQbot\.cache\harmonia\本次话题任务.txt"',
  '--output-schema', '"E:\QQbot\Harmonia\skills\harmonia-topic-research\output.schema.json"'
) -WindowStyle Hidden -PassThru
$worker.Id
```

沿用全局Codex配置与登录，不复制密钥、不另建项目登录环境。按Codex派活.md中的PID找到目录，间隔检查status.json；启动成功不是完成，不连续刷日志。超过本轮等待预算仍未完成，保留任务供之后检查，本轮可以reply=false，不盲目重新派一份相同任务。

## 接收与选择

status为completed后用pwsh执行：

```powershell
node E:\QQbot\Harmonia\scripts\check-topic-research.mjs "实际任务目录\result.md"
```

只接收校验通过、status=ok的3～5项候选。选一个适合此时场合、近期没有重复且自己能讲清的内容，用PERSONA.md中的语气开场；不要把整份报告转发给主人。最终JSON额外填sources:[{title,url}]，只用所选候选的已读来源。若insufficient、任务失败或没有合适话题，reply=false，不冒充已检索。

自然聊开后按普通对话继续；轻量补查可直接网页搜索，深入追查再把具体问题交给同一skill。记录主人对话题的实际反馈到INTERESTS.md，区分明确偏好和暂时推测。新知识是否值得记进统一长期记忆，仍由bot自行判断。

## 安装与验证

技能源码在Harmonia/skills/harmonia-topic-research；用户级 `.agents/skills/harmonia-topic-research` 是指向源码的junction，Codex显式调用和自动发现都可用。scripts/install-features.ps1在缺失时建立该入口，不覆盖已有同名技能。工作笔记在research持久保存、由文本备份覆盖；清理.cache仅影响当前临时任务，不删除技能或笔记。

2026-11-05已实际执行一次Codex检索：skill与笔记读取、网络检索和页面阅读、3项候选/4个来源、SOURCES.md更新均有回执；真实DSH独立选择1项并保留对应来源，未发测试消息。schema校验和71项应用测试、DSH/Responses集成通过。尚未用自然主动周期替代这次独立验收。
