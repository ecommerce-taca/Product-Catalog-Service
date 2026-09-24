import { Injectable, NestMiddleware } from '@nestjs/common';
import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { TraceContextData, TraceContextStorage } from '../context/trace-context.storage';

const W3C_TRACEPARENT_REGEX = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

@Injectable()
export class TraceContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const rawTraceparent = (req.headers['traceparent'] as string) || '';
    const rawRequestId = (req.headers['x-request-id'] as string) || '';

    let traceId: string;
    let spanId: string;
    let traceparent: string;

    const match = rawTraceparent.match(W3C_TRACEPARENT_REGEX);
    if (match) {
      traceId = match[1];
      // Generate a new span id for current processing
      spanId = randomBytes(8).toString('hex');
      traceparent = `00-${traceId}-${spanId}-${match[3]}`;
    } else {
      traceId = randomBytes(16).toString('hex');
      spanId = randomBytes(8).toString('hex');
      traceparent = `00-${traceId}-${spanId}-01`;
    }

    const requestId = rawRequestId || `req-${randomBytes(6).toString('hex')}`;

    const contextData: TraceContextData = {
      traceId,
      spanId,
      traceparent,
      requestId,
    };

    // Propagate headers to response
    res.setHeader('traceparent', traceparent);
    res.setHeader('X-Trace-ID', traceId);
    res.setHeader('X-Request-ID', requestId);

    TraceContextStorage.run(contextData, () => {
      next();
    });
  }
}
