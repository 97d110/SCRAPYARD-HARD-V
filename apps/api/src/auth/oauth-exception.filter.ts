import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';

/**
 * Turns a failed Google sign-in into a redirect back to the login screen with
 * a readable reason, instead of dumping a raw JSON 403 in the browser.
 *
 * This matters specifically because of the domain restriction: rejecting
 * out-of-domain accounts is the *expected* path for anyone outside the
 * Workspace, so it needs to look like a designed outcome rather than a crash.
 */
@Catch()
export class OAuthExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(OAuthExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    const message =
      exception instanceof HttpException
        ? extractMessage(exception)
        : 'Google sign-in failed. Please try again.';

    if (!(exception instanceof HttpException)) {
      this.logger.error(
        `Unexpected OAuth failure: ${
          exception instanceof Error ? exception.message : String(exception)
        }`,
      );
    }

    /*
     * Back to the server-rendered login page, not the SPA root. The SPA is
     * session-gated, so sending a rejected visitor there would just bounce them
     * here anyway — and this way the reason survives the trip.
     *
     * Relative, so it works whether Nest is serving the app itself or sitting
     * behind a dev proxy.
     */
    response.redirect(`/login?authError=${encodeURIComponent(message)}`);
  }
}

function extractMessage(exception: HttpException): string {
  const body = exception.getResponse();
  if (typeof body === 'string') return body;
  const detail = (body as { message?: string | string[] }).message;
  if (Array.isArray(detail)) return detail.join(', ');
  return detail ?? exception.message;
}
