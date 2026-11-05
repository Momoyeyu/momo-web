# stage assets

- `stage-room.jpg`：AI 生成后人工裁剪压缩（1536×988，~224KB），项目自用舞台背景。
  如需替换，保持同名或同步更新 `src/live2d/StageCanvas.tsx` 中的背景资源引用。

## Time-of-day variants (2026-11-05)

`room-morning.webp`, `room-evening.webp`, `room-night.webp`: generated edits of the original `stage-room.jpg` using imagegen; preserve the same room/camera, vary light and sky. Compressed WebP assets total about 284 KiB. Daytime uses the original image. No online asset generation at runtime.

Local computer time: morning 05:00–09:59, day 10:00–16:59, evening 17:00–19:59, night 20:00–04:59. These are art-direction intervals, not astronomical sunrise predictions. Decode before a 1.4-second opacity transition; reduced motion removes fading. Persistent stage, no character reload or navigation triggered. Check every minute and on focus/visibility return; failed decode keeps the previous background. Moving between locations is deferred.
