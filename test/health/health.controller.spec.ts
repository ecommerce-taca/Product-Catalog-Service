import { ServiceUnavailableException } from '@nestjs/common';
import { Connection } from 'mongoose';
import { HealthController } from '../../src/health/health.controller';

describe('HealthController', () => {
  let controller: HealthController;
  let mockConnection: {
    readyState: number;
    db?: { admin: () => { ping: jest.Mock } };
  };
  let mockAdminPing: jest.Mock;

  beforeEach(() => {
    mockAdminPing = jest.fn().mockResolvedValue({ ok: 1 });

    mockConnection = {
      readyState: 1,
      db: {
        admin: () => ({
          ping: mockAdminPing,
        }),
      },
    };

    controller = new HealthController(mockConnection as unknown as Connection);
  });

  describe('getLiveness', () => {
    it('should return UP for process liveness', () => {
      const response = controller.getLiveness();
      expect(response).toEqual({ status: 'UP' });
    });
  });

  describe('getReadiness', () => {
    it('should return UP when MongoDB connection is established and ping succeeds', async () => {
      const response = await controller.getReadiness();

      expect(response.status).toBe('UP');
      expect(response.checks).toHaveProperty('database');
      expect(response.checks?.database).toEqual(
        expect.objectContaining({
          status: 'UP',
          latency_ms: expect.any(Number),
        }),
      );
      expect(mockAdminPing).toHaveBeenCalledTimes(1);
    });

    it('should throw ServiceUnavailableException when connection is not ready (readyState !== 1)', async () => {
      mockConnection.readyState = 0; // disconnected

      await expect(controller.getReadiness()).rejects.toThrow(ServiceUnavailableException);
    });

    it('should throw ServiceUnavailableException when ping fails', async () => {
      mockAdminPing.mockRejectedValue(new Error('Connection timed out'));

      await expect(controller.getReadiness()).rejects.toThrow(ServiceUnavailableException);
    });

    it('should throw ServiceUnavailableException when connection.db is undefined', async () => {
      mockConnection.db = undefined;

      await expect(controller.getReadiness()).rejects.toThrow(ServiceUnavailableException);
    });
  });
});
