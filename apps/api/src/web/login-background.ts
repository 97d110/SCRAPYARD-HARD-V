import { existsSync, readdirSync } from 'fs';
import * as path from 'path';

/**
 * Where the login page's background footage comes from.
 *
 * Two sources, in priority order:
 *
 *  1. **A self-hosted file** in `apps/api/public/login/` (or WEB_LOGIN_ASSETS_DIR).
 *     Preferred — no third-party network dependency, no branding to crop, no
 *     embed that can be blocked, and it keeps working offline.
 *
 *  2. **A YouTube embed**, defaulting to the BlazeRush PS5 gameplay clip.
 *     Convenient, but it depends on YouTube being reachable and un-blocked at
 *     the moment someone signs in, so it's the fallback rather than the plan.
 *
 * If neither resolves, the page falls back to its animated grid, which is a
 * perfectly good background on its own.
 */

const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.m4v'];
const POSTER_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.avif'];

/** URL prefix the assets are served under — outside the session gate. */
export const LOGIN_ASSETS_ROUTE = '/login-assets';

export function loginAssetsDir(): string {
  return (
    process.env.WEB_LOGIN_ASSETS_DIR ??
    path.resolve(__dirname, '..', '..', 'public', 'login')
  );
}

export type LoginBackground =
  | { kind: 'file'; videoUrl: string; posterUrl: string | null; mimeType: string }
  | { kind: 'youtube'; videoId: string; posterUrl: string }
  | { kind: 'none' };

function mimeFor(extension: string): string {
  if (extension === '.webm') return 'video/webm';
  if (extension === '.mov' || extension === '.m4v') return 'video/quicktime';
  return 'video/mp4';
}

/** First matching file in the assets dir, by extension preference. */
function findAsset(dir: string, extensions: string[]): string | null {
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }

  for (const extension of extensions) {
    const match = entries.find(
      (entry) =>
        entry.toLowerCase().endsWith(extension) && entry.toLowerCase().startsWith('background'),
    );
    if (match) return match;
  }
  return null;
}

export function resolveLoginBackground(): LoginBackground {
  const dir = loginAssetsDir();

  // 1. Self-hosted file wins.
  const video = findAsset(dir, VIDEO_EXTENSIONS);
  if (video) {
    const poster = findAsset(dir, POSTER_EXTENSIONS);
    return {
      kind: 'file',
      videoUrl: `${LOGIN_ASSETS_ROUTE}/${encodeURIComponent(video)}`,
      posterUrl: poster ? `${LOGIN_ASSETS_ROUTE}/${encodeURIComponent(poster)}` : null,
      mimeType: mimeFor(path.extname(video).toLowerCase()),
    };
  }

  // 2. YouTube embed. Set to '' (or 'none') to disable entirely.
  const configured = process.env.LOGIN_BACKGROUND_YOUTUBE_ID;
  const videoId = configured === undefined ? 'xt_1gJkjdec' : configured.trim();

  if (!videoId || videoId.toLowerCase() === 'none') return { kind: 'none' };

  // Reject anything that isn't a plausible YouTube id so a bad env var can't
  // inject markup into the iframe src.
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return { kind: 'none' };

  return {
    kind: 'youtube',
    videoId,
    posterUrl: `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
  };
}
