export interface KafkaEventEnvelope<T = unknown> {
  event_id: string;
  schema_version?: number;
  event_type: string;
  occurred_at: string | Date;
  aggregate_type: string;
  aggregate_id: string;
  actor_user_id?: string | null;
  traceparent?: string | null;
  payload: T;
}

export interface DeadLetterEvent<T = unknown> {
  dlt_id: string;
  topic: string;
  original_event: KafkaEventEnvelope<T>;
  error_message: string;
  error_stack?: string;
  attempts: number;
  failed_at: Date;
}

export interface DispatchResult {
  success: boolean;
  event_id: string;
  event_type: string;
  attempts: number;
  sent_to_dlt: boolean;
  error?: string;
}
