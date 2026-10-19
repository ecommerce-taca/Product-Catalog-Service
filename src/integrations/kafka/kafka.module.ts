import { Global, Module } from '@nestjs/common';
import { KafkaEventDispatcher } from './kafka-event-dispatcher.service';
import { DeadLetterTopicService } from './dead-letter-topic.service';
import { KafkaConsumerService } from './kafka-consumer.service';

@Global()
@Module({
  providers: [DeadLetterTopicService, KafkaEventDispatcher, KafkaConsumerService],
  exports: [DeadLetterTopicService, KafkaEventDispatcher],
})
export class KafkaModule {}
