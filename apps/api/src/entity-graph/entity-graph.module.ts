import { Module } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { EntityGraphService } from './entity-graph.service';
import { PrismaEntityStore } from './prisma-entity-store';
import { ENTITY_GRAPH_STORE } from './entity-graph.tokens';

@Module({
  imports: [PrismaModule],
  providers: [
    PrismaEntityStore,
    { provide: ENTITY_GRAPH_STORE, useExisting: PrismaEntityStore },
    EntityGraphService,
  ],
  exports: [EntityGraphService],
})
export class EntityGraphModule {}
