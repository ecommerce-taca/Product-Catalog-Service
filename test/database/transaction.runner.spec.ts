import { Connection, ClientSession } from 'mongoose';
import { TransactionRunner } from '../../src/database/transaction.runner';

describe('TransactionRunner', () => {
  let transactionRunner: TransactionRunner;
  let mockConnection: jest.Mocked<Connection>;
  let mockSession: jest.Mocked<ClientSession>;

  beforeEach(() => {
    mockSession = {
      withTransaction: jest.fn().mockImplementation(async (callback: () => Promise<void>) => {
        await callback();
      }),
      endSession: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<ClientSession>;

    mockConnection = {
      startSession: jest.fn().mockResolvedValue(mockSession),
    } as unknown as jest.Mocked<Connection>;

    transactionRunner = new TransactionRunner(mockConnection);
  });

  it('should start session, execute withTransaction with configured options, and release session', async () => {
    const work = jest.fn().mockResolvedValue('transaction-result');

    const result = await transactionRunner.execute(work);

    expect(result).toBe('transaction-result');
    expect(mockConnection.startSession).toHaveBeenCalledTimes(1);
    expect(mockSession.withTransaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        readPreference: 'primary',
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority', j: true, wtimeoutMS: 5000 },
        maxCommitTimeMS: 5000,
      }),
    );
    expect(work).toHaveBeenCalledWith(mockSession);
    expect(mockSession.endSession).toHaveBeenCalledTimes(1);
  });

  it('should automatically retry when encountering TransientTransactionError and succeed on subsequent attempt', async () => {
    const transientError = Object.assign(new Error('Transient transaction error: Write conflict'), {
      errorLabels: ['TransientTransactionError'],
    });

    let attempts = 0;
    const work = jest.fn().mockImplementation(async () => {
      attempts++;
      if (attempts === 1) {
        throw transientError;
      }
      return 'retry-success-result';
    });

    mockSession.withTransaction.mockImplementation(
      async (callback: (session: ClientSession) => Promise<unknown>) => {
        let executionCount = 0;
        while (executionCount < 2) {
          executionCount++;
          try {
            await callback(mockSession);
            break;
          } catch (error: unknown) {
            const err = error as { errorLabels?: string[] };
            if (executionCount === 1 && err?.errorLabels?.includes('TransientTransactionError')) {
              continue;
            }
            throw error;
          }
        }
      },
    );

    const result = await transactionRunner.execute(work);

    expect(result).toBe('retry-success-result');
    expect(work).toHaveBeenCalledTimes(2);
    expect(mockSession.withTransaction).toHaveBeenCalledTimes(1);
    expect(mockSession.endSession).toHaveBeenCalledTimes(1);
  });

  it('should rollback and cleanup session when transaction encounters an unrecoverable business error', async () => {
    const businessError = new Error('Unrecoverable business error: Product not found');
    const failingWork = jest.fn().mockRejectedValue(businessError);

    await expect(transactionRunner.execute(failingWork)).rejects.toThrow(
      'Unrecoverable business error: Product not found',
    );

    expect(failingWork).toHaveBeenCalledWith(mockSession);
    expect(mockConnection.startSession).toHaveBeenCalledTimes(1);
    expect(mockSession.withTransaction).toHaveBeenCalledTimes(1);
    expect(mockSession.endSession).toHaveBeenCalledTimes(1);
  });

  it('should release session in finally block even if work throws an error', async () => {
    const error = new Error('Database write failure');
    const failingWork = jest.fn().mockRejectedValue(error);

    await expect(transactionRunner.execute(failingWork)).rejects.toThrow('Database write failure');

    expect(mockConnection.startSession).toHaveBeenCalledTimes(1);
    expect(mockSession.endSession).toHaveBeenCalledTimes(1);
  });
});
