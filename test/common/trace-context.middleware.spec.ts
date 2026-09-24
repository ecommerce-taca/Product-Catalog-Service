import { Request, Response, NextFunction } from 'express';
import { TraceContextMiddleware } from '../../src/common/middleware/trace-context.middleware';
import { TraceContextStorage } from '../../src/common/context/trace-context.storage';

describe('TraceContextMiddleware', () => {
  let middleware: TraceContextMiddleware;

  beforeEach(() => {
    middleware = new TraceContextMiddleware();
  });

  it('should parse incoming valid W3C traceparent and preserve traceId', (done) => {
    const validTraceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

    const req = {
      headers: {
        traceparent: validTraceparent,
        'x-request-id': 'req-fixed-123',
      },
    } as unknown as Request;

    const setHeaderMock = jest.fn();
    const res = {
      setHeader: setHeaderMock,
    } as unknown as Response;

    const next: NextFunction = () => {
      expect(TraceContextStorage.getTraceId()).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
      expect(TraceContextStorage.getRequestId()).toBe('req-fixed-123');

      expect(setHeaderMock).toHaveBeenCalledWith('X-Trace-ID', '4bf92f3577b34da6a3ce929d0e0e4736');
      expect(setHeaderMock).toHaveBeenCalledWith('X-Request-ID', 'req-fixed-123');
      expect(setHeaderMock).toHaveBeenCalledWith(
        'traceparent',
        expect.stringMatching(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/),
      );
      done();
    };

    middleware.use(req, res, next);
  });

  it('should generate fresh W3C traceparent and requestId if missing from headers', (done) => {
    const req = {
      headers: {},
    } as unknown as Request;

    const setHeaderMock = jest.fn();
    const res = {
      setHeader: setHeaderMock,
    } as unknown as Response;

    const next: NextFunction = () => {
      const traceId = TraceContextStorage.getTraceId();
      const requestId = TraceContextStorage.getRequestId();
      const traceparent = TraceContextStorage.getTraceparent();

      expect(traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(requestId).toMatch(/^req-[0-9a-f]{12}$/);
      expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

      expect(setHeaderMock).toHaveBeenCalledWith('X-Trace-ID', traceId);
      expect(setHeaderMock).toHaveBeenCalledWith('X-Request-ID', requestId);
      expect(setHeaderMock).toHaveBeenCalledWith('traceparent', traceparent);
      done();
    };

    middleware.use(req, res, next);
  });
});
