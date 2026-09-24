import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { OutboxEvent, OutboxEventSchema } from '../database/schemas/outbox-event.schema';
import { OutboxRepositoryPort } from './repositories/outbox.repository.interface';
import { OutboxRepository } from './repositories/outbox.repository';

@Module({
  imports: [MongooseModule.forFeature([{ name: OutboxEvent.name, schema: OutboxEventSchema }])],
  providers: [
    {
      provide: OutboxRepositoryPort,
      useClass: OutboxRepository,
    },
  ],
  exports: [OutboxRepositoryPort],
})
export class OutboxModule {}
