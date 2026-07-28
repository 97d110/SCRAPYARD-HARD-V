/**
 * Service worker registration, and the update path that goes with it.
 *
 * Registering is the easy half. The half that matters for this app is picking up
 * a new build: Scrapyard is meant to live on a wall display that nobody ever
 * reloads, so without an explicit update path a deploy would reach every phone
 * in the crew and never reach the screen everyone actually looks at.
 *
 * Three prompts to look for a new worker, cheapest first:
 *
 *   - the tab becoming visible again, which covers every phone;
 *   - a timer, which covers the display nobody touches;
 *   - the live socket reporting a server it hasn't seen before, which is the
 *     earliest and most precise signal a deploy just landed (see AppStore).
 *
 * When one is found, `sw.js` calls `skipWaiting()` and claims its clients, the
 * browser fires `controllerchange`, and the page reloads itself once onto the
 * new bundle.
 */

/** Long enough to be nearly free; short enough that a wall display is current. */
const UPDATE_INTERVAL_MS = 30 * 60 * 1000;

let registration: ServiceWorkerRegistration | null = null;

export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return;

  /*
   * Whether this page load is already under a worker's control, captured
   * *before* registering. It's the difference between "a new version has taken
   * over" and "the very first worker just installed" — both fire
   * `controllerchange`, but only the first is worth a reload.
   */
  const wasControlled = navigator.serviceWorker.controller !== null;

  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!wasControlled || reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js')
      .then((result) => {
        registration = result;

        window.setInterval(() => void checkForServiceWorkerUpdate(), UPDATE_INTERVAL_MS);
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void checkForServiceWorkerUpdate();
        });
      })
      .catch(() => {
        // A failed registration must never block the app — installability is a
        // progressive enhancement, not a requirement.
      });
  });
}

/**
 * Ask the browser to re-fetch `sw.js` and swap it in if the bytes differ.
 *
 * Safe to call at any time and as often as you like: with no registration yet
 * it does nothing, and when the worker is unchanged the browser answers from a
 * conditional request.
 */
export async function checkForServiceWorkerUpdate(): Promise<void> {
  try {
    await registration?.update();
  } catch {
    // Offline, or the worker's script is briefly unreachable mid-deploy.
  }
}
