import { ArgumentsHost, BadRequestException, HttpStatus, NotFoundException } from '@nestjs/common';
import { GlobalExceptionFilter } from '../../src/common/filters/global-exception.filter';
import { TraceContextStorage } from '../../src/common/context/trace-context.storage';

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
  });

  const createMockArgumentsHost = () => {
    const jsonMock = jest.fn();
    const statusMock = jest.fn().mockReturnValue({ json: jsonMock });
    const responseMock = { status: statusMock };

    const host = {
      switchToHttp: () => ({
        getResponse: () => responseMock,
        getRequest: () => ({}),
      }),
    } as unknown as ArgumentsHost;

    return { host, statusMock, jsonMock };
  };

  it('should format HttpException into standard error envelope', () => {
    const { host, statusMock, jsonMock } = createMockArgumentsHost();
    const exception = new NotFoundException('Sản phẩm không tồn tại.');

    filter.catch(exception, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.NOT_FOUND);
    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'PRODUCT_NOT_FOUND',
          message: 'Sản phẩm không tồn tại.',
          trace_id: expect.any(String),
        }),
      }),
    );
  });

  it('should format ValidationPipe errors into PRODUCT_INVALID_INPUT with details', () => {
    const { host, statusMock, jsonMock } = createMockArgumentsHost();
    const exception = new BadRequestException({
      statusCode: 400,
      message: ['title must be longer than 3 characters', 'price must be positive'],
      error: 'Bad Request',
    });

    filter.catch(exception, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'PRODUCT_INVALID_INPUT',
        message: 'Dữ liệu đầu vào không hợp lệ.',
        details: [
          { message: 'title must be longer than 3 characters' },
          { message: 'price must be positive' },
        ],
        trace_id: expect.any(String),
      },
    });
  });

  it('should format Mongo duplicate slug error (code 11000) as PRODUCT_SLUG_CONFLICT', () => {
    const { host, statusMock, jsonMock } = createMockArgumentsHost();
    const mongoDuplicateError = {
      code: 11000,
      keyPattern: { slug: 1 },
      message: 'E11000 duplicate key error collection',
    };

    filter.catch(mongoDuplicateError, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'PRODUCT_SLUG_CONFLICT',
        message: 'Đường dẫn (slug) đã tồn tại.',
        trace_id: expect.any(String),
      },
    });
  });

  it('should format Mongo duplicate SKU error (code 11000) as PRODUCT_SKU_DUPLICATE', () => {
    const { host, statusMock, jsonMock } = createMockArgumentsHost();
    const mongoDuplicateError = {
      code: 11000,
      keyPattern: { seller_sku: 1 },
      message: 'E11000 duplicate key error collection',
    };

    filter.catch(mongoDuplicateError, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.CONFLICT);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'PRODUCT_SKU_DUPLICATE',
        message: 'Mã SKU hoặc biến thể bị trùng lặp.',
        trace_id: expect.any(String),
      },
    });
  });

  it('should format unexpected exceptions into safe 500 INTERNAL_ERROR without leaking stack trace', () => {
    const { host, statusMock, jsonMock } = createMockArgumentsHost();
    const secretDbError = new Error('FATAL: password authentication failed for user "postgres"');

    filter.catch(secretDbError, host);

    expect(statusMock).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
    expect(jsonMock).toHaveBeenCalledWith({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Đã có lỗi xảy ra trong quá trình xử lý hệ thống.',
        trace_id: expect.any(String),
      },
    });
  });

  it('should retrieve trace_id from TraceContextStorage if available', () => {
    const { host, jsonMock } = createMockArgumentsHost();
    const exception = new NotFoundException();

    TraceContextStorage.run(
      {
        traceId: '1234567890abcdef1234567890abcdef',
        spanId: '1234567890abcdef',
        traceparent: '00-1234567890abcdef1234567890abcdef-1234567890abcdef-01',
        requestId: 'req-test',
      },
      () => {
        filter.catch(exception, host);
      },
    );

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          trace_id: '1234567890abcdef1234567890abcdef',
        }),
      }),
    );
  });
});
