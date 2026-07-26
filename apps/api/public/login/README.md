# Login page background

Drop a video here and the login page will use it instead of the YouTube embed.

## Naming

The file must be named `background.*`:

| File | Purpose |
| --- | --- |
| `background.mp4` (or `.webm`, `.mov`, `.m4v`) | the looping footage |
| `background.jpg` (or `.png`, `.webp`, `.avif`) | poster still, painted instantly before the video is ready |

`.mp4` is picked first if several exist. Nothing else in this folder is read.

## Why self-hosting is the better option

The default background is a YouTube embed of
[(PS5) BlazeRush | Gameplay](https://www.youtube.com/watch?v=xt_1gJkjdec) by
Immortalize Games. It works with zero setup, but it is the *fallback*, not the
plan:

- it needs YouTube reachable and un-blocked at the exact moment someone signs in
- corporate networks and extensions block embeds routinely
- the player's branding has to be cropped by overscaling, which wastes pixels
- you're re-publishing someone else's footage — fine for an internal tool, worth
  a thought if this ever faces outward

A self-hosted file has none of those problems, and the page reveals the media
layer only once it's genuinely playing, so a blocked embed degrades to the
poster and animated grid rather than a black rectangle.

## Getting a file

Record your own BlazeRush footage, or use clips the publisher offers for reuse.
Then keep it small — this loads before anyone is authenticated:

```bash
# 12s loop, 1080p, no audio, ~1-2 MB
ffmpeg -i source.mp4 -ss 00:00:04 -t 12 \
  -vf "scale=1920:-2,fps=30" \
  -c:v libx264 -crf 30 -preset slow -pix_fmt yuv420p \
  -movflags +faststart -an \
  background.mp4

# poster from the first frame
ffmpeg -i background.mp4 -frames:v 1 -q:v 3 background.jpg
```

Aim for **under 3 MB**. It is served uncached to first-time visitors on the
critical path of the login screen.

## Configuration

| Variable | Effect |
| --- | --- |
| `LOGIN_BACKGROUND_YOUTUBE_ID` | override the embed id; set to `none` to disable video entirely |
| `WEB_LOGIN_ASSETS_DIR` | serve these assets from somewhere other than this folder |

With no video from either source the page falls back to the animated perspective
grid, which is a complete design on its own — the dim, vignette and panel
layering all still apply.

Files in this folder are gitignored apart from this README.
