import { Injectable } from '@nestjs/common';
import { Connection, ClientSession } from 'mongoose';
import { InjectConnection } from '@nestjs/mongoose';

@Injectable()
export class TransactionRunner {
  constructor(@InjectConnection() private readonly connection: Connection) {}

  /**
   * Executes a unit of work inside a MongoDB multi-document transaction.
   * Leverages session.withTransaction() to automatically retry on
   * TransientTransactionError and UnknownTransactionCommitResult.
   * Guarantees session release via finally block.
   */
  async execute<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await this.connection.startSession();
    try {
      let result: T;
      await session.withTransaction(
        async () => {
          result = await work(session);
        },
        {
          readPreference: 'primary',
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority', j: true, wtimeoutMS: 5000 },
          maxCommitTimeMS: 5000,
        },
      );
      return result!;
    } finally {
      await session.endSession();
    }
  }
}
