import { ExecutionContext, CallHandler } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of, lastValueFrom } from 'rxjs';
import {
  ResponseEnvelopeInterceptor,
  serializeBigInt,
} from '../../src/common/interceptors/response-envelope.interceptor';

describe('ResponseEnvelopeInterceptor & serializeBigInt', () => {
  describe('serializeBigInt', () => {
    it('should convert BigInt to Number', () => {
      const input = BigInt(1500000);
      const output = serializeBigInt(input);
      expect(output).toBe(1500000);
      expect(typeof output).toBe('number');
    });

    it('should recursively convert nested BigInts in objects and arrays', () => {
      const input = {
        title: 'Áo thun nam',
        price_summary: {
          base_price: 200000n,
          sale_price: 150000n,
        },
        skus: [
          { sku_id: 'sku-1', price_override: 180000n },
          { sku_id: 'sku-2', price_override: null },
        ],
        created_at: new Date('2026-09-24T00:00:00.000Z'),
        is_active: true,
      };

      const output = serializeBigInt(input) as typeof input;
      expect(output.price_summary.base_price).toBe(200000);
      expect(typeof output.price_summary.base_price).toBe('number');
      expect(output.price_summary.sale_price).toBe(150000);
      expect(typeof output.price_summary.sale_price).toBe('number');
      expect(output.skus[0].price_override).toBe(180000);
      expect(output.skus[1].price_override).toBeNull();
      expect(output.created_at).toBeInstanceOf(Date);
      expect(output.is_active).toBe(true);
    });

    it('should handle Mongoose document like objects with toJSON()', () => {
      const doc = {
        _id: '01912f31-7a1b-7c12-9c55-8b1c34a6d921',
        version: 1n,
        price: 500000n,
        toJSON: () => ({
          _id: '01912f31-7a1b-7c12-9c55-8b1c34a6d921',
          version: 1n,
          price: 500000n,
        }),
      };

      const output = serializeBigInt(doc) as {
        _id: string;
        version: number;
        price: number;
      };
      expect(output.version).toBe(1);
      expect(typeof output.version).toBe('number');
      expect(output.price).toBe(500000);
      expect(typeof output.price).toBe('number');
    });

    it('should safely handle primitive types, null and undefined', () => {
      expect(serializeBigInt('string')).toBe('string');
      expect(serializeBigInt(123)).toBe(123);
      expect(serializeBigInt(true)).toBe(true);
      expect(serializeBigInt(null)).toBeNull();
      expect(serializeBigInt(undefined)).toBeUndefined();
    });
  });

  describe('ResponseEnvelopeInterceptor', () => {
    let interceptor: ResponseEnvelopeInterceptor;
    let reflector: Reflector;

    beforeEach(() => {
      reflector = new Reflector();
      interceptor = new ResponseEnvelopeInterceptor(reflector);
    });

    const createMockExecutionContext = (
      url = '/api/v1/products',
      skip = false,
    ): ExecutionContext => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(skip);

      const request = {
        path: url,
        headers: { 'x-request-id': 'req-test-123' },
      };

      return {
        getHandler: jest.fn(),
        getClass: jest.fn(),
        switchToHttp: () => ({
          getRequest: () => request,
        }),
      } as unknown as ExecutionContext;
    };

    it('should wrap raw response with standard data and meta envelope', async () => {
      const context = createMockExecutionContext();
      const callHandler: CallHandler = {
        handle: () => of({ id: 'prod-1', base_price: 300000n }),
      };

      const result$ = interceptor.intercept(context, callHandler);
      const result = (await lastValueFrom(result$)) as {
        data: { id: string; base_price: number };
        meta: { request_id: string; as_of: string };
      };

      expect(result).toHaveProperty('data');
      expect(result).toHaveProperty('meta');
      expect(result.data.id).toBe('prod-1');
      expect(result.data.base_price).toBe(300000);
      expect(result.meta.request_id).toBe('req-test-123');
      expect(result.meta.as_of).toBeDefined();
    });

    it('should preserve and merge existing meta in paginated response', async () => {
      const context = createMockExecutionContext();
      const callHandler: CallHandler = {
        handle: () =>
          of({
            data: [{ id: 'p1' }, { id: 'p2' }],
            meta: { page: 1, size: 20, total: 2 },
          }),
      };

      const result$ = interceptor.intercept(context, callHandler);
      const result = (await lastValueFrom(result$)) as {
        data: unknown[];
        meta: {
          page: number;
          size: number;
          total: number;
          request_id: string;
          as_of: string;
        };
      };

      expect(result.data).toHaveLength(2);
      expect(result.meta.page).toBe(1);
      expect(result.meta.size).toBe(20);
      expect(result.meta.total).toBe(2);
      expect(result.meta.request_id).toBe('req-test-123');
      expect(result.meta.as_of).toBeDefined();
    });

    it('should bypass envelope for health endpoints', async () => {
      const context = createMockExecutionContext('/health/live');
      const callHandler: CallHandler = {
        handle: () => of({ status: 'UP' }),
      };

      const result$ = interceptor.intercept(context, callHandler);
      const result = await lastValueFrom(result$);

      expect(result).toEqual({ status: 'UP' });
    });

    it('should bypass envelope when SkipEnvelope is active', async () => {
      const context = createMockExecutionContext('/api/v1/custom', true);
      const callHandler: CallHandler = {
        handle: () => of({ raw: 'data' }),
      };

      const result$ = interceptor.intercept(context, callHandler);
      const result = await lastValueFrom(result$);

      expect(result).toEqual({ raw: 'data' });
    });
  });
});
