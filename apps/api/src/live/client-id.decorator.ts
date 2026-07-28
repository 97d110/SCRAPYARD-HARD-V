import { ExecutionContext, createParamDecorator } from '@nestjs/common';
import { Request } from 'express';
import { CLIENT_ID_HEADER } from './live.constants';

/**
 * The calling tab's `X-Scrapyard-Client` id, or undefined.
 *
 * Sits next to `@CurrentUser()` in a mutating handler and is passed straight to
 * `LiveGateway.broadcast` as `origin`. Deliberately untrusted and unvalidated
 * beyond a length cap: the worst a forged value can do is make one *other* tab
 * skip one refetch, which the next event corrects. It never grants anything.
 */
export const ClientId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers[CLIENT_ID_HEADER];
    const value = Array.isArray(header) ? header[0] : header;
    const trimmed = value?.trim();
    return trimmed && trimmed.length <= 64 ? trimmed : undefined;
  },
);
