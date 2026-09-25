import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ActorContextGuard } from '../../src/common/guards/actor-context.guard';

describe('ActorContextGuard', () => {
  let guard: ActorContextGuard;
  let reflector: Reflector;

  beforeEach(() => {
    reflector = new Reflector();
    guard = new ActorContextGuard(reflector);
  });

  const createMockExecutionContext = (
    headers: Record<string, string> = {},
    isPublic = false,
    requiredRoles?: string[],
    requiredPermissions?: string[],
  ): ExecutionContext => {
    jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: unknown) => {
      if (key === 'isPublic') return isPublic;
      if (key === 'roles') return requiredRoles;
      if (key === 'permissions') return requiredPermissions;
      return undefined;
    });

    const request = {
      headers,
      actor: undefined,
    };

    return {
      getHandler: jest.fn(),
      getClass: jest.fn(),
      switchToHttp: () => ({
        getRequest: () => request,
      }),
    } as unknown as ExecutionContext;
  };

  it('should allow public routes even with no headers', () => {
    const context = createMockExecutionContext({}, true);
    const result = guard.canActivate(context);

    expect(result).toBe(true);
    const req = context.switchToHttp().getRequest();
    expect(req.actor).toEqual({
      userId: undefined,
      roles: [],
      permissions: [],
      shopScope: undefined,
      isAuthenticated: false,
    });
  });

  it('should correctly extract ActorContext from Gateway headers', () => {
    const headers = {
      'x-user-id': '01912f31-7a1b-7c12-9c55-8b1c34a6d921',
      'x-user-roles': 'SELLER, SELLER_STAFF',
      'x-user-permissions': 'PRODUCT_WRITE, PRODUCT_PUBLISH',
      'x-user-shop-scope': '01912f31-7a1b-7c12-9c55-8b1c34a6d999',
    };

    const context = createMockExecutionContext(headers, false, ['SELLER']);
    const result = guard.canActivate(context);

    expect(result).toBe(true);
    const req = context.switchToHttp().getRequest();
    expect(req.actor).toEqual({
      userId: '01912f31-7a1b-7c12-9c55-8b1c34a6d921',
      roles: ['SELLER', 'SELLER_STAFF'],
      permissions: ['PRODUCT_WRITE', 'PRODUCT_PUBLISH'],
      shopScope: '01912f31-7a1b-7c12-9c55-8b1c34a6d999',
      isAuthenticated: true,
    });
  });

  it('should allow SUPER_ADMIN even if role is not in requiredRoles list', () => {
    const headers = {
      'x-user-id': 'admin-uuid',
      'x-user-roles': 'SUPER_ADMIN',
    };

    const context = createMockExecutionContext(headers, false, ['CATALOG_ADMIN']);
    const result = guard.canActivate(context);

    expect(result).toBe(true);
  });

  it('should throw UnauthorizedException when route requires roles but user is not authenticated', () => {
    const context = createMockExecutionContext({}, false, ['SELLER']);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when route is not public and user is not authenticated (deny-by-default)', () => {
    const context = createMockExecutionContext({}, false);

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('should allow authenticated user on non-public route when no specific roles are required', () => {
    const headers = {
      'x-user-id': '01912f31-7a1b-7c12-9c55-8b1c34a6d921',
    };
    const context = createMockExecutionContext(headers, false);
    const result = guard.canActivate(context);

    expect(result).toBe(true);
  });

  it('should throw ForbiddenException when user lacks required role', () => {
    const headers = {
      'x-user-id': 'buyer-uuid',
      'x-user-roles': 'BUYER',
    };

    const context = createMockExecutionContext(headers, false, ['SELLER']);

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  describe('Permissions validation (Blocker B-1 fix)', () => {
    it('should throw ForbiddenException (PRODUCT_FORBIDDEN) when user has empty permissions but route requires permissions', () => {
      const headers = {
        'x-user-id': 'seller-uuid',
        'x-user-roles': 'SELLER',
        // no x-user-permissions header -> actor.permissions = []
      };

      const context = createMockExecutionContext(
        headers,
        false,
        ['SELLER'],
        ['catalog:product:write'],
      );

      try {
        guard.canActivate(context);
        fail('Expected ForbiddenException');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        const res = (err as ForbiddenException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_FORBIDDEN');
        expect(res.message).toBe('Insufficient permissions');
      }
    });

    it('should throw ForbiddenException when user lacks one of the required permissions', () => {
      const headers = {
        'x-user-id': 'seller-uuid',
        'x-user-roles': 'SELLER',
        'x-user-permissions': 'catalog:product:read',
      };

      const context = createMockExecutionContext(
        headers,
        false,
        ['SELLER'],
        ['catalog:product:read', 'catalog:product:write'],
      );

      try {
        guard.canActivate(context);
        fail('Expected ForbiddenException');
      } catch (err) {
        expect(err).toBeInstanceOf(ForbiddenException);
        const res = (err as ForbiddenException).getResponse() as Record<string, unknown>;
        expect(res.code).toBe('PRODUCT_FORBIDDEN');
        expect(res.message).toBe('Insufficient permissions');
      }
    });

    it('should allow user when all required permissions are present', () => {
      const headers = {
        'x-user-id': 'seller-uuid',
        'x-user-roles': 'SELLER',
        'x-user-permissions': 'catalog:product:read, catalog:product:write',
      };

      const context = createMockExecutionContext(
        headers,
        false,
        ['SELLER'],
        ['catalog:product:read', 'catalog:product:write'],
      );

      expect(guard.canActivate(context)).toBe(true);
    });

    it('should allow SUPER_ADMIN even if required permissions are not present', () => {
      const headers = {
        'x-user-id': 'admin-uuid',
        'x-user-roles': 'SUPER_ADMIN',
      };

      const context = createMockExecutionContext(headers, false, undefined, [
        'catalog:product:write',
      ]);

      expect(guard.canActivate(context)).toBe(true);
    });
  });
});
