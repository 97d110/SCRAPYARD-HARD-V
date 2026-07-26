import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  createParamDecorator,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import type { PublicUser } from '@scrapyard/shared';

/** Requires a valid session cookie (or Bearer token). */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}

/** Requires a valid session *and* the admin role. */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request & { user?: PublicUser }>();
    if (request.user?.role !== 'admin') {
      throw new ForbiddenException('Admin access required');
    }
    return true;
  }
}

/** `@CurrentUser() user: PublicUser` in any guarded controller method. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PublicUser => {
    const request = context.switchToHttp().getRequest<Request & { user: PublicUser }>();
    return request.user;
  },
);
