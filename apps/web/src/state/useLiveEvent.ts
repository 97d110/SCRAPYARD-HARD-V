import { useEffect, useRef, useState } from 'react';
import { live, type LiveStatus } from '../lib/live';
import type { LiveEventType, LiveFrame } from '@scrapyard/shared';

/**
 * Run something when a live event of interest arrives.
 *
 * For data a page loads for itself — a profile bundle, an admin panel's list —
 * rather than the shared boards/roster/puns that AppStore owns. The typical use
 * is one line next to the `useEffect` that already loads it:
 *
 *     useLiveEvent(['game:recorded', 'game:deleted'], load);
 *
 * `handler` is read through a ref, so an inline arrow doesn't resubscribe on
 * every render and callers don't have to memoise anything. Frames the tab
 * caused itself never arrive here — the channel drops those upstream.
 */
export function useLiveEvent(
  types: readonly LiveEventType[],
  handler: (frame: LiveFrame) => void,
): void {
  const latest = useRef(handler);
  latest.current = handler;

  // Compared by content, not identity, so a fresh array literal per render
  // (which is the natural way to call this) doesn't churn the subscription.
  const key = types.join('|');

  useEffect(() => {
    const wanted = new Set<string>(key ? key.split('|') : []);
    return live.subscribe((frame) => {
      if (wanted.has(frame.type)) latest.current(frame);
    });
  }, [key]);
}

/**
 * The live channel's connection state, for the indicator in the top bar.
 *
 * Subscribing here also opens the socket, which is why the shell showing the
 * indicator is enough to establish the connection.
 */
export function useLiveStatus(): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>(live.status);
  useEffect(() => live.onStatus(setStatus), []);
  return status;
}
