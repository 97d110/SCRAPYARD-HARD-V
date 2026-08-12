import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';
import { MongoService } from '../database/mongo.service';
import type { PushSubscriptionInput } from '@scrapyard/shared';

/**
 * Web Push, end to end.
 *
 * Entirely optional infrastructure: with no VAPID keys configured, every
 * method here is a no-op (or a clear 400 for the one that would otherwise
 * silently do nothing useful) rather than a crash at boot. That matters
 * because this feature ships opt-in — an existing deployment that hasn't set
 * `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` yet must keep working exactly as
 * before.
 *
 * One subscription per browser, keyed by its own endpoint URL (see
 * `PushSubscriptionDoc`) — a racer signed in on three devices has three
 * documents, and turning notifications off on one leaves the other two alone.
 * That mirrors how every real Web Push implementation behaves: it is a
 * per-device setting, not an account-wide flag.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly vapidPublicKey?: string;
  private readonly configured: boolean;

  constructor(private readonly mongo: MongoService) {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    const subject = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

    this.vapidPublicKey = publicKey;
    this.configured = Boolean(publicKey && privateKey);

    if (this.configured) {
      webpush.setVapidDetails(subject, publicKey!, privateKey!);
    } else {
      this.logger.warn(
        'VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — push notifications are disabled',
      );
    }
  }

  /** Null when unconfigured — the client hides the opt-in toggle entirely. */
  publicKey(): string | null {
    return this.configured ? (this.vapidPublicKey ?? null) : null;
  }

  /** Upsert by endpoint: re-subscribing the same browser just refreshes it. */
  async subscribe(userId: string, input: PushSubscriptionInput, userAgent?: string): Promise<void> {
    if (!this.configured) {
      throw new BadRequestException('Push notifications are not configured on this server');
    }
    const subscriptions = await this.mongo.pushSubscriptions();
    await subscriptions.updateOne(
      { _id: input.endpoint },
      {
        $set: { userId, keys: input.keys, ...(userAgent ? { userAgent } : {}) },
        $setOnInsert: { createdAt: new Date().toISOString() },
      },
      { upsert: true },
    );
  }

  /**
   * Scoped to the caller's own userId so one racer can't unsubscribe another's
   * device even if they somehow learned its endpoint.
   */
  async unsubscribe(userId: string, endpoint: string): Promise<void> {
    const subscriptions = await this.mongo.pushSubscriptions();
    await subscriptions.deleteOne({ _id: endpoint, userId });
  }

  /**
   * Fan a "race recorded" push out to every subscribed device.
   *
   * Deliberately swallows everything — a push failure, or the feature being
   * unconfigured, must never affect recording a race. Call sites hand this to
   * `waitUntil` rather than awaiting it: notifying the room is not part of the
   * request that just happened, but on a serverless runtime it still has to be
   * registered with the platform or it may never run at all.
   */
  async notifyRaceRecorded(payload: {
    winnerName: string;
    finishers: number;
    note?: string;
  }): Promise<void> {
    if (!this.configured) return;

    try {
      const subscriptions = await this.mongo.pushSubscriptions();
      const all = await subscriptions.find({}).toArray();
      if (all.length === 0) return;

      const headline =
        payload.finishers > 1
          ? `${payload.winnerName} took the win in a ${payload.finishers}-car race.`
          : `${payload.winnerName} just logged a win.`;
      const message = JSON.stringify({
        title: 'New race recorded',
        body: payload.note ? `${headline} ${payload.note}` : headline,
        url: '/',
      });

      const results = await Promise.allSettled(
        all.map((sub) => webpush.sendNotification({ endpoint: sub._id, keys: sub.keys }, message)),
      );

      let delivered = 0;
      let pruned = 0;
      await Promise.all(
        results.map(async (result, index) => {
          if (result.status === 'fulfilled') {
            delivered += 1;
            return;
          }
          const reason = result.reason as unknown;
          // 404/410 means the push service itself says this subscription is
          // gone for good — the browser was uninstalled, permission revoked at
          // the OS level, whatever. Self-heal rather than retry forever.
          const statusCode = reason instanceof webpush.WebPushError ? reason.statusCode : undefined;
          if (statusCode === 404 || statusCode === 410) {
            pruned += 1;
            await subscriptions.deleteOne({ _id: all[index]._id }).catch(() => {});
          } else {
            this.logger.warn(
              `Push delivery failed (${statusCode ?? 'unknown'}): ${
                reason instanceof Error ? reason.message : String(reason)
              }`,
            );
          }
        }),
      );

      this.logger.log(
        `Race-recorded push: ${delivered}/${all.length} delivered` +
          `${pruned ? `, ${pruned} expired subscription(s) pruned` : ''}`,
      );
    } catch (error) {
      this.logger.warn(
        `Push fan-out failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
