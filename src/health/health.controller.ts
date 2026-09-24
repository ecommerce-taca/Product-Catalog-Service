import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { Public } from '../common/decorators/public.decorator';
import { SkipEnvelope } from '../common/decorators/skip-envelope.decorator';

export interface HealthResponse {
  status: string;
  checks?: Record<string, unknown>;
}

@Controller('health')
export class HealthController {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  @Get('live')
  @Public()
  @SkipEnvelope()
  getLiveness(): HealthResponse {
    return { status: 'UP' };
  }

  @Get('ready')
  @Public()
  @SkipEnvelope()
  async getReadiness(): Promise<HealthResponse> {
    const startTime = Date.now();

    // 1. Kiểm tra trạng thái kết nối Mongoose Driver
    // readyState: 0 = disconnected, 1 = connected, 2 = connecting, 3 = disconnecting
    if (this.connection.readyState !== 1) {
      throw new ServiceUnavailableException({
        status: 'DOWN',
        checks: {
          database: {
            status: 'DOWN',
            message: 'MongoDB connection is not established',
          },
        },
      });
    }

    // 2. Thực hiện lệnh Ping với Timeout 1500ms
    try {
      if (!this.connection.db) {
        throw new Error('Database instance is undefined');
      }

      let timeoutId: NodeJS.Timeout | undefined;
      const pingPromise = this.connection.db.admin().ping();
      const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error('MongoDB ping timeout')), 1500);
      });

      try {
        await Promise.race([pingPromise, timeoutPromise]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
      const latency_ms = Date.now() - startTime;

      return {
        status: 'UP',
        checks: {
          database: {
            status: 'UP',
            latency_ms,
          },
        },
      };
    } catch (error) {
      const err = error as Error;
      throw new ServiceUnavailableException({
        status: 'DOWN',
        checks: {
          database: {
            status: 'DOWN',
            message: `MongoDB ping failed: ${err.message}`,
          },
        },
      });
    }
  }
}
