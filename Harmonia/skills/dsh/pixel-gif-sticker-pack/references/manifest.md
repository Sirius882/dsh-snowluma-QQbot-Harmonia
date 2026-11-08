# Atlas exporter manifest

Supply a JSON file with a title, the exact sticker count, and an ordered list of groups. Each atlas is a transparent PNG with one sprite per equal grid cell. Paths are relative to the manifest. Use zero-based column and row coordinates.

```json
{
  "title": "雨天搭档",
  "count": 2,
  "groups": [{
    "name": "日常",
    "atlas": "sample-atlas.png",
    "grid": [2, 1],
    "ink": "#5E4493",
    "tint": "#C8B2F4",
    "background": "#EBE3FA",
    "entries": [
      {"text":"醒醒","cell":[0,0],"motion":"startle","icon":"alert"},
      {"text":"晚安","cell":[1,0],"motion":"breathe","icon":"sleep"}
    ]
  }]
}
```

For a sheet with uneven gutters, set an entry's optional `crop` to pixel coordinates `[left, top, right, bottom]`. The selected area must contain the complete sprite, with transparent separation from adjacent sprites. Review the crop visually before rendering.

Motion presets include `nod`, `jump`, `sway`, `startle`, `tremble`, `ponder`, `breathe`, `stomp`, `rush`, `peek`, `pulse`, `pop`, `offer`, `lean`, `droop`, and `dance`. They translate, squash, and shear the sprite, with timing chosen for a short reaction. They do not generate new character poses inside a loop.

Use `spark`, `heart`, `tear`, `check`, `question`, `alert`, `sleep`, `steam`, `note`, `cross`, `bubble`, `dots`, `bolt`, `arrow`, `petal`, or `none` for a moving accent. Use `none` when the pose already has enough visual detail.

```sh
python3 scripts/export_pack.py manifest.json build --font /path/to/font.ttf --preview
```

Use `--font-index` for a specific face inside a TTC. The output must be empty of earlier exports. The exporter writes a categorized GIF folder, an offline gallery that travels with the ZIP, and an optional MP4. Use `--jobs 2` if the environment needs fewer concurrent workers. The MP4 path requires FFmpeg with libx264. Pillow is required for GIF export.
