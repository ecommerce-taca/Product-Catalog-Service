import { registerAs } from '@nestjs/config';
import { ConnectOptions } from 'mongoose';

export interface DatabaseConfig {
  uri: string;
  options: ConnectOptions;
}

export const mongooseConnectionOptions: ConnectOptions = {
  // Pool Sizing
  maxPoolSize: 20,
  minPoolSize: 5,
  maxIdleTimeMS: 30000,

  // Timeouts
  socketTimeoutMS: 30000,
  serverSelectionTimeoutMS: 5000,

  // High Availability & Retries
  retryWrites: true,
  retryReads: true,
  heartbeatFrequencyMS: 10000,

  // Write Concern & Read Preference
  w: 'majority',
  journal: true,
  wtimeoutMS: 5000,
  readPreference: 'primaryPreferred',
};

export default registerAs('database', (): DatabaseConfig => ({
  uri: process.env.MONGODB_URI || 'mongodb://localhost:27017/product_catalog?replicaSet=rs0',
  options: {
    ...mongooseConnectionOptions,
    minPoolSize: process.env.MONGODB_MIN_POOL_SIZE
      ? parseInt(process.env.MONGODB_MIN_POOL_SIZE, 10)
      : mongooseConnectionOptions.minPoolSize,
    maxPoolSize: process.env.MONGODB_MAX_POOL_SIZE
      ? parseInt(process.env.MONGODB_MAX_POOL_SIZE, 10)
      : mongooseConnectionOptions.maxPoolSize,
    socketTimeoutMS: process.env.MONGODB_SOCKET_TIMEOUT_MS
      ? parseInt(process.env.MONGODB_SOCKET_TIMEOUT_MS, 10)
      : mongooseConnectionOptions.socketTimeoutMS,
    serverSelectionTimeoutMS: process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS
      ? parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS, 10)
      : mongooseConnectionOptions.serverSelectionTimeoutMS,
    readPreference:
      (process.env.MONGODB_READ_PREFERENCE as ConnectOptions['readPreference']) ||
      mongooseConnectionOptions.readPreference,
  },
}));
