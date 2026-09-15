import { Injectable } from '@nestjs/common';
import { ThrottlerGuard } from '@nestjs/throttler';

/**
 * Keys rate limits on the real client, not on whatever proxy forwarded them.
 *
 * Every browser request reaches this API through the Next.js proxy on Vercel,
 * so `req.ip` is one address for the entire user base. The login limit of five
 * per minute was therefore five per minute *in total* — a single shift change
 * would lock everyone out, and one attacker could lock out every legitimate user
 * by consuming the shared budget.
 *
 * `X-Forwarded-For` is a client-supplied header and is spoofable, so it is only
 * trusted when TRUST_PROXY is on — i.e. when the deployment genuinely sits
 * behind a proxy that overwrites it. The *left-most* entry is the original
 * client; entries to its right are the proxy chain.
 *
 * The authenticated user id is preferred where present: it is the one identifier
 * a caller cannot forge, and it stops a whole office behind one NAT address from
 * sharing a single budget.
 */
@Injectable()
export class ClientIpThrottlerGuard extends ThrottlerGuard {
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const user = req.user as { userId?: string } | undefined;
    if (user?.userId) {
      return `user:${user.userId}`;
    }

    const headers = (req.headers ?? {}) as Record<string, string | string[] | undefined>;

    // Only honour the forwarded chain when the app is configured to sit behind a
    // proxy; otherwise anyone could set it and mint themselves a fresh budget.
    const trustsProxy = process.env.TRUST_PROXY === 'true' || process.env.NODE_ENV === 'production';

    if (trustsProxy) {
      const forwarded = headers['x-forwarded-for'];
      const chain = Array.isArray(forwarded) ? forwarded[0] : forwarded;
      const client = chain?.split(',')[0]?.trim();
      if (client) return `ip:${client}`;
    }

    const ip = (req.ip as string) || 'unknown';
    return `ip:${ip}`;
  }
}
