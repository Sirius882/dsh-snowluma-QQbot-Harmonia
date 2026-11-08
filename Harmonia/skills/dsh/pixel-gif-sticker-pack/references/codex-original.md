---
name: pixel-gif-sticker-pack
description: Turn an authorized character illustration, mascot, or rendered 3D reference into a pack of individually animated chat sticker GIFs, with a playable preview and verified ZIP. Use for single packs and large themed series with distinct expressions and gestures.
---

# Animated chat sticker packs

Carry forward the latest reference, required count, format, language, and visual constraints. For a GLB, render a front or three-quarter reference with the face and identifying details visible. If the user supplied a drawing, preserve the recognizable silhouette, facial features, palette, and signature accessories. Use only imagery the user provided or authorized for the task.

## Design and generate

- For a large pack, plan categories first and give each sticker a chat line, a visible pose or prop, and an animated beat. Review neighboring concepts for semantic duplicates. An identical pose with new text alone is insufficient.
- Use the image generation tool for new pose art. Ask for one transparent sprite atlas at a time, usually a 4 × 4 sheet with wide gutters and no lettering. Give exact reading order, stable framing and identity anchors. Keep lettering in composition, where it can be verified.
- Inspect each atlas at full size. Count actual occupied cells, map each cell to its visible pose, and correct a mismatched caption or regenerate an unusable sprite. Watch for swapped cells, clipped hair or hands, and artifacts across gutters. A 100-sticker pack needs 100 accepted entries.
- For tiny chat previews, prefer strong readable facial expressions, a short caption and one clear moving accent. Let each motion settle naturally into the next loop. Keep the original source and generated atlases outside the shareable ZIP unless requested.

## Compose and verify

For a repeatable workflow, use [the atlas exporter](scripts/export_pack.py) with Python 3 and Pillow. It uses FFmpeg for MP4 playback. Run `python3 scripts/export_pack.py --help` and read [the manifest format](references/manifest.md) for cell overrides and motion presets. Choose a local font that covers the requested captions. Use another compositor when the brief requires actual skeletal or frame-by-frame character animation.

Deliver one transparent looping GIF per entry, grouped in a ZIP. Default to 320 × 320 and roughly two seconds when the user gave no target platform spec. A separate MP4 assembled from the decoded GIFs makes playback inspectable even in a chat surface that shows a still. A static contact sheet can help compare designs when clearly identified as a still.

Verify exact count and unique captions, visible movement, frame timing, loop flag, alpha, safe margins, ZIP integrity and MP4 decoding. Inspect each category visually. Report actual deliverables and any limits that affect use. A local playback check does not establish compatibility with a specific messaging platform.
