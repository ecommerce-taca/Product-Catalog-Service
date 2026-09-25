import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { ActorContext } from '../context/actor-context.interface';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';

@Injectable()
export class ActorContextGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<Request>();
    const actor = this.extractActorContext(request);
    request.actor = actor;

    if (isPublic) {
      return true;
    }

    // Zero-Trust Deny-by-Default: All non-public endpoints require an authenticated actor
    if (!actor.isAuthenticated) {
      throw new UnauthorizedException({
        code: 'UNAUTHORIZED',
        message: 'Yêu cầu xác thực tài khoản.',
      });
    }

    const requiredRoles = this.reflector.getAllAndOverride<string[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredRoles && requiredRoles.length > 0) {
      const hasRole =
        actor.roles.includes('SUPER_ADMIN') ||
        requiredRoles.some((role) => actor.roles.includes(role));

      if (!hasRole) {
        throw new ForbiddenException({
          code: 'PRODUCT_FORBIDDEN',
          message: 'Bạn không có quyền thực hiện thao tác này.',
        });
      }
    }

    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (requiredPermissions && requiredPermissions.length > 0) {
      const hasPermission =
        actor.roles.includes('SUPER_ADMIN') ||
        (actor.permissions.length > 0 &&
          requiredPermissions.every((perm) => actor.permissions.includes(perm)));

      if (!hasPermission) {
        throw new ForbiddenException({
          code: 'PRODUCT_FORBIDDEN',
          message: 'Insufficient permissions',
        });
      }
    }

    return true;
  }

  private extractActorContext(request: Request): ActorContext {
    const userIdHeader = request.headers['x-user-id'] as string | undefined;
    const rolesHeader = request.headers['x-user-roles'] as string | undefined;
    const permissionsHeader = request.headers['x-user-permissions'] as string | undefined;
    const shopScopeHeader = request.headers['x-user-shop-scope'] as string | undefined;

    const userId = userIdHeader?.trim() || undefined;
    const roles = rolesHeader
      ? rolesHeader
          .split(',')
          .map((r) => r.trim().toUpperCase())
          .filter(Boolean)
      : [];
    const permissions = permissionsHeader
      ? permissionsHeader
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : [];
    const shopScope = shopScopeHeader?.trim() || undefined;

    return {
      userId,
      roles,
      permissions,
      shopScope,
      isAuthenticated: Boolean(userId),
    };
  }
}
