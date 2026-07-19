import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { EntityGraphService } from './entity-graph.service';
import { PrismaEntityStore } from './prisma-entity-store';
import { ENTITY_GRAPH_STORE } from './entity-graph.tokens';
import { PrismaEntityGraphRepository } from './prisma-entity-graph.repository';
import { ENTITY_GRAPH_REPOSITORY } from './domain/entity-graph.domain';
import { EntityGraphOutboxSubscriber } from './entity-graph-outbox.subscriber';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  imports: [PrismaModule, OutboxModule],
  providers: [
    PrismaEntityStore,
    { provide: ENTITY_GRAPH_STORE, useExisting: PrismaEntityStore },
    PrismaEntityGraphRepository,
    { provide: ENTITY_GRAPH_REPOSITORY, useExisting: PrismaEntityGraphRepository },
    EntityGraphService,
    EntityGraphOutboxSubscriber,
  ],
  exports: [EntityGraphService],
})
export class EntityGraphModule {}
