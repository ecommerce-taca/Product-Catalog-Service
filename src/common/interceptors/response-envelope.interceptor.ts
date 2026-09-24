import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';
import { TraceContextStorage } from '../context/trace-context.storage';
import { SKIP_ENVELOPE_KEY } from '../decorators/skip-envelope.decorator';

/**
 * Recursively converts all native BigInt fields (BSON Long) to JavaScript numbers.
 * Safe for VND amounts <= 999,999,999,999 as demonstrated in DB5 / Q-01.
 */
export function serializeBigInt(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'bigint') {
    return Number(value);
  }
  if (typeof value === 'object') {
    if (value instanceof Date) {
      return value;
    }
    // Handle Mongoose documents
    if (typeof (value as { toJSON?: () => unknown }).toJSON === 'function') {
      return serializeBigInt((value as { toJSON: () => unknown }).toJSON());
    }
    if (Array.isArray(value)) {
      return value.map((item) => serializeBigInt(item));
    }
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = serializeBigInt(v);
    }
    return result;
  }
  return value;
}

@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skipEnvelope = this.reflector.getAllAndOverride<boolean>(SKIP_ENVELOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const request = context.switchToHttp().getRequest<Request>();
    const isHealthRoute = request?.path?.includes('/health');

    return next.handle().pipe(
      map((res) => {
        const serialized = serializeBigInt(res);

        if (skipEnvelope || isHealthRoute) {
          return serialized;
        }

        const requestId =
          TraceContextStorage.getRequestId() ||
          (request?.headers?.['x-request-id'] as string) ||
          '';
        const asOf = new Date().toISOString();

        if (
          serialized &&
          typeof serialized === 'object' &&
          'data' in serialized &&
          'meta' in serialized
        ) {
          const typedRes = serialized as {
            data: unknown;
            meta: Record<string, unknown>;
          };
          return {
            data: typedRes.data,
            meta: {
              request_id: requestId,
              as_of: asOf,
              ...typedRes.meta,
            },
          };
        }

        return {
          data: serialized ?? null,
          meta: {
            request_id: requestId,
            as_of: asOf,
          },
        };
      }),
    );
  }
}
