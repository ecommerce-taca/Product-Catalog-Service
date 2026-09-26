import { Global, Module } from '@nestjs/common';
import { KafkaEventDispatcher } from './kafka-event-dispatcher.service';
import { DeadLetterTopicService } from './dead-letter-topic.service';

@Global()
@Module({
  providers: [DeadLetterTopicService, KafkaEventDispatcher],
  exports: [DeadLetterTopicService, KafkaEventDispatcher],
})
export class KafkaModule {}
