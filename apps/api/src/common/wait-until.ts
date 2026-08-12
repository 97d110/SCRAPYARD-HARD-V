import { waitUntil as vercelWaitUntil } from '@vercel/functions';

/**
 * Keep a promise alive past the response it was started from.
 *
 * On a long-lived server, `void somePromise()` works: the process is still
 * there afterwards, so the work finishes on its own. On a serverless runtime it
 * quietly does not — an instance may be frozen the instant its response is
 * flushed, and anything still pending is abandoned mid-flight. The failure mode
 * is the bad kind: intermittent, silent, and dependent on how quickly the
 * platform reclaims the instance, so it looks like a delivery bug rather than a
 * lifecycle one.
 *
 * `waitUntil` tells the platform to hold the instance open until the promise
 * settles, without making the caller wait for it.
 *
 * The try/catch is for everywhere that isn't Vercel — `npm run dev`, the smoke
 * suite, a container — where there is no request context to register against.
 * There the original behaviour is correct and this becomes a plain `void`.
 */
export function waitUntil(promise: Promise<unknown>): void {
  // Nothing here reports failures: every caller is work whose whole point is
  // that it must not affect the request that triggered it.
  const settled = promise.catch(() => undefined);

  try {
    vercelWaitUntil(settled);
  } catch {
    void settled;
  }
}
