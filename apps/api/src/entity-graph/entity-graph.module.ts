import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { EntityGraphService } from './entity-graph.service';
import { PrismaEntityStore } from './prisma-entity-store';
import { ENTITY_GRAPH_STORE } from './entity-graph.tokens';
import { PrismaEntityGraphRepository } from './prisma-entity-graph.repository';
import { ENTITY_GRAPH_REPOSITORY } from './domain/entity-graph.domain';
import { EntityGraphOutboxSubscriber } from './entity-graph-outbox.subscriber';
import { OutboxModule } from '../outbox/outbox.module';

@Module({
  // OutboxModule still imports EntityGraphModule directly (plain, non-forwardRef) to
  // resolve the optional EntityGraphService injected into OutboxFanOutRegistry. Until
  // task 1.5 removes that reverse edge, both sides of this module pair form a true
  // circular import; wrap it here so Nest resolves the reference lazily instead of
  // hitting the ESM temporal dead zone (surfaced as "module at index [n] is undefined"
  // in vcs.module.spec.ts / code-intel.module.spec.ts).
  imports: [PrismaModule, forwardRef(() => OutboxModule)],
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
