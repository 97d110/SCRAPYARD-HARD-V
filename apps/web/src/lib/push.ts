import { api } from './api';

/**
 * Web Push subscribe/unsubscribe, plus the boilerplate every implementation
 * needs: `PushManager.subscribe()` wants its VAPID key as a `Uint8Array`, not
 * the base64url string the server hands back.
 *
 * Dev-mode note: the service worker only registers in production builds (see
 * `pwa.ts`), so `isPushSupported()` can say "the browser can do this" but a
 * subscribe attempt in `npm run dev` will still fail with no worker to attach
 * to — same limitation as the rest of the PWA, not something specific to push.
 */

function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  // `applicationServerKey` wants a view backed specifically by `ArrayBuffer`
  // (not the wider `ArrayBufferLike`, which also covers `SharedArrayBuffer`)
  // under current TS DOM typings — hence the explicit buffer rather than
  // `new Uint8Array(length)` or `Uint8Array.from(...)`, neither of which TS
  // narrows that precisely.
  const buffer = new ArrayBuffer(raw.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Feature support only — says nothing about whether a subscription exists. */
export function isPushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** The raw browser subscription object `sendNotification` needs the shape of. */
function toSubscriptionInput(subscription: PushSubscription): {
  endpoint: string;
  keys: { p256dh: string; auth: string };
} {
  const json = subscription.toJSON();
  return {
    endpoint: json.endpoint ?? subscription.endpoint,
    keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
  };
}

/** Null if unsupported or there's no active subscription on this device. */
export async function getPushSubscription(): Promise<PushSubscription | null> {
  if (!isPushSupported()) return null;
  try {
    const registration = await navigator.serviceWorker.ready;
    return await registration.pushManager.getSubscription();
  } catch {
    return null;
  }
}

/**
 * Request permission (if not already granted), subscribe this browser, and
 * tell the server about it. Throws on any failure — permission denied, no
 * VAPID key configured server-side, the service worker not being ready —
 * so the caller's toggle can show *why* it didn't turn on.
 */
export async function subscribeToPush(): Promise<void> {
  if (!isPushSupported()) throw new Error('This browser does not support push notifications');

  const { publicKey } = await api.push.publicKey();
  if (!publicKey) throw new Error('Push notifications are not configured on this server');

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted');

  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(publicKey),
  });

  await api.push.subscribe(toSubscriptionInput(subscription));
}

/** Unsubscribes both locally and on the server. Safe to call with no subscription. */
export async function unsubscribeFromPush(): Promise<void> {
  const subscription = await getPushSubscription();
  if (!subscription) return;

  const endpoint = subscription.endpoint;
  await subscription.unsubscribe();
  await api.push.unsubscribe(endpoint);
}
