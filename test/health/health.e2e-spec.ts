import { Test, TestingModule } from '@nestjs/testing';
import {
  BadRequestException,
  Controller,
  Get,
  Global,
  INestApplication,
  InternalServerErrorException,
  Module,
} from '@nestjs/common';
import request from 'supertest';
import { getConnectionToken } from '@nestjs/mongoose';
import { AppModule } from 'src/app.module';
import { DatabaseModule } from 'src/database/database.module';
import { TransactionRunner } from 'src/database/transaction.runner';
import { Public } from 'src/common/decorators/public.decorator';

@Controller('test-envelope-errors')
class TestEnvelopeErrorsController {
  @Get('validation-error')
  @Public()
  throwValidationError() {
    throw new BadRequestException({
      code: 'PRODUCT_INVALID_INPUT',
      message: ['Title is required', 'Price must be greater than 0'],
    });
  }

  @Get('unhandled-error')
  @Public()
  throwUnhandledError() {
    throw new InternalServerErrorException('Unexpected database failure');
  }
}

describe('Health & Infrastructure E2E Tests', () => {
  let app: INestApplication;
  let mockAdminPing: jest.Mock;
  let mockConnection: {
    readyState: number;
    db?: { admin: () => { ping: jest.Mock } };
    models: Record<string, unknown>;
    model: jest.Mock;
  };

  beforeAll(async () => {
    mockAdminPing = jest.fn().mockResolvedValue({ ok: 1 });
    mockConnection = {
      readyState: 1,
      db: {
        admin: () => ({
          ping: mockAdminPing,
        }),
      },
      models: {},
      model: jest.fn().mockReturnValue({}),
    };

    @Global()
    @Module({
      providers: [
        {
          provide: getConnectionToken(),
          useValue: mockConnection,
        },
        {
          provide: TransactionRunner,
          useValue: { run: jest.fn() },
        },
      ],
      exports: [getConnectionToken(), TransactionRunner],
    })
    class MockDatabaseModule {}

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [TestEnvelopeErrorsController],
    })
      .overrideModule(DatabaseModule)
      .useModule(MockDatabaseModule)
      .compile();

    app = moduleFixture.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(() => {
    mockAdminPing = jest.fn().mockResolvedValue({ ok: 1 });
    mockConnection.readyState = 1;
    mockConnection.db = {
      admin: () => ({
        ping: mockAdminPing,
      }),
    };
  });

  describe('GET /health/live', () => {
    it('should return HTTP 200 with status UP', async () => {
      const response = await request(app.getHttpServer()).get('/health/live').expect(200);

      expect(response.body).toEqual({ status: 'UP' });
      // Verify SkipEnvelope decorator prevented wrapping in { data, meta }
      expect(response.body).not.toHaveProperty('data');
      expect(response.body).not.toHaveProperty('meta');
    });
  });

  describe('GET /health/ready', () => {
    it('should return HTTP 200 with status UP and database latency when connected', async () => {
      const response = await request(app.getHttpServer()).get('/health/ready').expect(200);

      expect(response.body).toEqual({
        status: 'UP',
        checks: {
          database: {
            status: 'UP',
            latency_ms: expect.any(Number),
          },
        },
      });
      expect(response.body.checks.database.latency_ms).toBeGreaterThanOrEqual(0);
      expect(mockAdminPing).toHaveBeenCalledTimes(1);
    });

    it('should return HTTP 503 Service Unavailable when database is disconnected (readyState !== 1)', async () => {
      mockConnection.readyState = 0; // disconnected

      const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

      expect(response.body).toEqual({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: expect.any(String),
          trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      });
    });

    it('should return HTTP 503 Service Unavailable when database ping fails', async () => {
      mockAdminPing.mockRejectedValue(new Error('MongoDB ping timeout'));

      const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

      expect(response.body).toEqual({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: expect.any(String),
          trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      });
    });

    it('should return HTTP 503 Service Unavailable when connection.db is undefined', async () => {
      mockConnection.db = undefined;

      const response = await request(app.getHttpServer()).get('/health/ready').expect(503);

      expect(response.body).toEqual({
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: expect.any(String),
          trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      });
    });
  });

  describe('TraceContextMiddleware (W3C traceparent propagation)', () => {
    it('should generate valid W3C traceparent, trace_id, and request_id when client sends no trace headers', async () => {
      const response = await request(app.getHttpServer()).get('/health/live').expect(200);

      const traceparentHeader = response.headers['traceparent'];
      const traceIdHeader = response.headers['x-trace-id'];
      const requestIdHeader = response.headers['x-request-id'];

      expect(traceparentHeader).toBeDefined();
      expect(traceIdHeader).toBeDefined();
      expect(requestIdHeader).toBeDefined();

      // W3C traceparent regex: 00-{trace_id}-{span_id}-{flags}
      const match = traceparentHeader.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/);
      expect(match).not.toBeNull();
      if (!match) throw new Error('Traceparent header does not match expected format');

      // Trace ID in header must match the trace_id in traceparent
      expect(traceIdHeader).toBe(match[1]);

      // Request ID starts with req-
      expect(requestIdHeader).toMatch(/^req-[0-9a-f]{12}$/);
    });

    it('should propagate incoming traceId and keep incoming x-request-id', async () => {
      const incomingTraceId = '4bf92f3577b34da6a3ce929d0e0e4736';
      const incomingSpanId = '00f067aa0ba902b7';
      const incomingTraceparent = `00-${incomingTraceId}-${incomingSpanId}-01`;
      const incomingRequestId = 'client-custom-req-id-777';

      const response = await request(app.getHttpServer())
        .get('/health/live')
        .set('traceparent', incomingTraceparent)
        .set('x-request-id', incomingRequestId)
        .expect(200);

      expect(response.headers['x-request-id']).toBe(incomingRequestId);
      expect(response.headers['x-trace-id']).toBe(incomingTraceId);

      const traceparentHeader = response.headers['traceparent'];
      const match = traceparentHeader.match(/^00-([0-9a-f]{32})-([0-9a-f]{16})-01$/);
      expect(match).not.toBeNull();
      if (!match) throw new Error('Traceparent header does not match expected format');
      expect(match[1]).toBe(incomingTraceId);
      // SpanId should be newly generated (different from incoming spanId)
      expect(match[2]).not.toBe(incomingSpanId);
    });
  });

  describe('GlobalExceptionFilter (Error Envelope)', () => {
    it('should format 404 Not Found into standardized error envelope', async () => {
      const response = await request(app.getHttpServer())
        .get('/health/non-existent-route')
        .expect(404);

      expect(response.body).toEqual({
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: expect.any(String),
          trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      });

      // trace_id in body must match X-Trace-ID response header
      expect(response.body.error.trace_id).toBe(response.headers['x-trace-id']);
    });

    it('should format validation errors into standardized error envelope with details', async () => {
      const response = await request(app.getHttpServer())
        .get('/test-envelope-errors/validation-error')
        .expect(400);

      expect(response.body).toEqual({
        error: {
          code: 'PRODUCT_INVALID_INPUT',
          message: 'Dữ liệu đầu vào không hợp lệ.',
          details: [{ message: 'Title is required' }, { message: 'Price must be greater than 0' }],
          trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      });
      expect(response.body.error.trace_id).toBe(response.headers['x-trace-id']);
    });

    it('should format 500 unhandled errors into standardized error envelope', async () => {
      const response = await request(app.getHttpServer())
        .get('/test-envelope-errors/unhandled-error')
        .expect(500);

      expect(response.body).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Unexpected database failure',
          trace_id: expect.stringMatching(/^[0-9a-f]{32}$/),
        },
      });
      expect(response.body.error.trace_id).toBe(response.headers['x-trace-id']);
    });
  });
});
