---
name: pixel-gif-sticker-pack
description: 在DSH直接绘制并导出有中文短句、动作和透明背景的GIF聊天表情，适用于私聊或群聊的定制斗图回应。
---

# GIF表情包制作

这是已安装的同名Codex技能的DSH适配，复用其Pillow导出器；不调用Codex。你用SVG绘制原创角色，由专用工具完成栅格化、中文排版、动画和验证。当前没有额外的文生图模型，不把程序绘制说成图像模型生成。

按当前要求决定角色、表情、中文短句与动作。参考图片只作为视觉资料；保留有权使用的角色特征、轮廓、配色与配饰。主动斗图做一张贴合语境的图即可，多张应有不同姿态，不能只换文字。

调用 `draw_meme`：

- `svg`：完整的SVG画面，`viewBox="0 0 320 320"`，主体留安全边距，透明背景，脸部清楚，底部留约70像素放短句。用形状和path原创绘制，不画文字。禁止外链、image/use、脚本、外部字体或磁盘路径。
- `caption`：1～24字的中文短句，工具使用本机中文字库排版。
- `meaning`：画面、情绪、适用场景与关键词，供共享表情索引检索。
- `motion`：nod/jump/sway/startle/tremble/ponder/breathe/stomp/rush/peek/pulse/pop/offer/lean/droop/dance。
- `icon`：spark/heart/tear/check/question/alert/sleep/steam/note/cross/bubble/dots/bolt/arrow/petal/none。

工具生成320×320、24帧、约1.92秒的透明循环GIF，并验证帧数和循环；复用[原导出器](scripts/export_pack.py)的动作预设，预设是移动、挤压和倾斜，不会自行画出眨眼或嘴型新姿态。

把成功结果中的 `sticker` 原样填到最终回复JSON的 `sticker`；宿主发到当前聊天。不要写Markdown图片、本机路径或调用其他渠道。失败据实回复，不伪称已画好。工具只负责制作，不直接发送消息。

需要超出此工具的复杂动画、角色新姿势或大套图时，说明当前绘制方式的限制。完整图集清单格式见[manifest](references/manifest.md)，原技能说明保存在[Codex原文](references/codex-original.md)。
