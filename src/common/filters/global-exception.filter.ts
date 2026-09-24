import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Response } from 'express';
import { TraceContextStorage } from '../context/trace-context.storage';

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details?: Array<Record<string, unknown>>;
    trace_id: string;
  };
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    const traceId = TraceContextStorage.getTraceId() || '00000000000000000000000000000000';

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'Đã có lỗi xảy ra trong quá trình xử lý hệ thống.';
    let details: Array<Record<string, unknown>> | undefined;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'string') {
        message = res;
        code = this.mapStatusToCode(status);
      } else if (typeof res === 'object' && res !== null) {
        const body = res as Record<string, unknown>;
        code = (body.code as string) || this.mapStatusToCode(status);

        if (Array.isArray(body.message)) {
          // Class validator error
          code = 'PRODUCT_INVALID_INPUT';
          message = 'Dữ liệu đầu vào không hợp lệ.';
          details = body.message.map((m) =>
            typeof m === 'object' && m !== null
              ? (m as Record<string, unknown>)
              : { message: String(m) },
          );
        } else if (typeof body.message === 'string') {
          message = body.message;
        }

        if (Array.isArray(body.details)) {
          details = body.details as Array<Record<string, unknown>>;
        }
      }
    } else if (this.isMongoDuplicateError(exception)) {
      status = HttpStatus.CONFLICT;
      const mongoErr = exception as { keyPattern?: Record<string, number> };
      if (mongoErr.keyPattern?.slug) {
        code = 'PRODUCT_SLUG_CONFLICT';
        message = 'Đường dẫn (slug) đã tồn tại.';
      } else if (mongoErr.keyPattern?.seller_sku || mongoErr.keyPattern?.variant_key) {
        code = 'PRODUCT_SKU_DUPLICATE';
        message = 'Mã SKU hoặc biến thể bị trùng lặp.';
      } else {
        code = 'PRODUCT_STATE_INVALID';
        message = 'Dữ liệu đã tồn tại trong hệ thống.';
      }
    } else {
      // Unhandled 500 error: safe logging
      const err = exception as Error;
      this.logger.error(
        `[UnhandledException] trace_id=${traceId} error=${err?.message || exception}`,
        err?.stack,
      );
    }

    const errorResponse: ErrorEnvelope = {
      error: {
        code,
        message,
        ...(details && details.length > 0 ? { details } : {}),
        trace_id: traceId,
      },
    };

    response.status(status).json(errorResponse);
  }

  private isMongoDuplicateError(exception: unknown): boolean {
    return (
      typeof exception === 'object' &&
      exception !== null &&
      'code' in exception &&
      (exception as { code: unknown }).code === 11000
    );
  }

  private mapStatusToCode(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'PRODUCT_INVALID_INPUT';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'PRODUCT_FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'PRODUCT_NOT_FOUND';
      case HttpStatus.CONFLICT:
        return 'PRODUCT_STATE_INVALID';
      case HttpStatus.SERVICE_UNAVAILABLE:
        return 'SERVICE_UNAVAILABLE';
      default:
        return 'INTERNAL_ERROR';
    }
  }
}
