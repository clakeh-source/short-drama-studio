# Stub media fixtures

These are what the `stub` video and render adapters hand back. They are committed
on purpose: without them the stub pipeline is not end-to-end, and the first real
run through the UI failed with `Could not download the generated file (404 from
provider)` on every shot that reached the download step.

| File | What it is | Used by |
|---|---|---|
| `clip.mp4` | 8s SMPTE bars, 1080x1920 @ 30fps, H.264 | `StubVideoProvider` — 8s is the longest shot duration, so any shot length trims from it |
| `episode.mp4` | 6s SMPTE bars with a 220Hz tone, same format | `StubRenderProvider` |

Static bars rather than moving test patterns, so they compress to tens of
kilobytes instead of megabytes. The format is deliberately identical to the real
deliverable — 1080x1920, 30fps, H.264 — so the ffmpeg adapter is conforming real
inputs rather than a shape that happens to already be right.

Regenerate with:

```bash
ffmpeg -f lavfi -i "smptebars=size=1080x1920:rate=30:duration=8" \
  -c:v libx264 -crf 38 -preset veryslow -tune stillimage \
  -pix_fmt yuv420p -g 300 -movflags +faststart -y public/stub/clip.mp4

ffmpeg -f lavfi -i "smptebars=size=1080x1920:rate=30:duration=6" \
  -f lavfi -i "sine=frequency=220:duration=6" \
  -c:v libx264 -crf 38 -preset veryslow -tune stillimage -pix_fmt yuv420p -g 300 \
  -c:a aac -b:a 64k -movflags +faststart -y public/stub/episode.mp4
```
