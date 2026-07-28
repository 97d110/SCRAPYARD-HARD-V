/**
 * This tab's identity on the live channel.
 *
 * Sent on every mutating request and echoed back on the resulting live event as
 * `origin`, which is how a tab recognises — and ignores — the consequences of
 * its own writes. It already applied the response; refetching would be work for
 * nothing, and re-running the winner's flyby would fire it twice.
 *
 * **Per tab, not per user, and not persisted.** Two tabs of the same account
 * must each see the other's changes, and somebody scoring a race from their
 * phone must still watch it land on the wall display. A fresh id per page load
 * is also exactly right: "a tab that has already applied this response" cannot
 * outlive the tab.
 *
 * The header name is duplicated from `apps/api/src/live/live.constants.ts`
 * rather than imported: `@scrapyard/shared` is a declaration file and holds no
 * runtime values by design, so a shared string constant has nowhere to live.
 */
export const CLIENT_ID_HEADER = 'X-Scrapyard-Client';

export const CLIENT_ID: string = createId();

function createId(): string {
  // Available in every secure context, which includes http://localhost.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Nothing here is security-sensitive — a collision would cost one tab one
  // skipped refetch — so a cheap fallback is enough.
  return `tab-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}
