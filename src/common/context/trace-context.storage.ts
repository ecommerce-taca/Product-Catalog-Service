import { AsyncLocalStorage } from 'async_hooks';

export interface TraceContextData {
  traceId: string;
  spanId: string;
  traceparent: string;
  requestId: string;
}

export class TraceContextStorage {
  private static readonly storage = new AsyncLocalStorage<TraceContextData>();

  static get(): TraceContextData | undefined {
    return this.storage.getStore();
  }

  static getTraceId(): string {
    return this.storage.getStore()?.traceId || '';
  }

  static getTraceparent(): string {
    return this.storage.getStore()?.traceparent || '';
  }

  static getRequestId(): string {
    return this.storage.getStore()?.requestId || '';
  }

  static run<R>(data: TraceContextData, callback: () => R): R {
    return this.storage.run(data, callback);
  }
}
