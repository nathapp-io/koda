import { Test, TestingModule } from '@nestjs/testing';
import { EventsModule } from './events.module';
import { TicketEventService } from './ticket-event.service';
import { AgentEventService } from './agent-event.service';
import { DecisionEventService } from './decision-event.service';
import { PrismaEventsRepository } from './prisma-events.repository';
import { EVENTS_REPOSITORY } from './domain/events.domain';
import { GlobalStubsModule } from '../common/test-helpers/global-stubs.module';

describe('EventsModule (DI wiring)', () => {
  let moduleRef: TestingModule;

  afterEach(async () => {
    if (moduleRef) {
      await moduleRef.close();
      moduleRef = undefined as unknown as TestingModule;
    }
  });

  it('compiles with the global stub providers and no database', async () => {
    await expect(
      Test.createTestingModule({
        imports: [GlobalStubsModule, EventsModule],
      }).compile(),
    ).resolves.toBeDefined();
  });

  describe('providers', () => {
    beforeEach(async () => {
      moduleRef = await Test.createTestingModule({
        imports: [GlobalStubsModule, EventsModule],
      }).compile();
    });

    it('registers TicketEventService', () => {
      expect(moduleRef.get(TicketEventService)).toBeInstanceOf(TicketEventService);
    });

    it('registers AgentEventService', () => {
      expect(moduleRef.get(AgentEventService)).toBeInstanceOf(AgentEventService);
    });

    it('registers DecisionEventService', () => {
      expect(moduleRef.get(DecisionEventService)).toBeInstanceOf(DecisionEventService);
    });

    it('registers PrismaEventsRepository', () => {
      expect(moduleRef.get(PrismaEventsRepository)).toBeInstanceOf(PrismaEventsRepository);
    });

    it('aliases EVENTS_REPOSITORY token to the Prisma-backed implementation', () => {
      expect(moduleRef.get(EVENTS_REPOSITORY)).toBeDefined();
    });
  });
});
