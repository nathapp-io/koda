import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { runAsSystemWriter } from '../../action-context/action-context';
import { SystemWriter } from '../../permissions/system-writer.decorator';
import { THREAD_SPEC_PUBLISHED, type ThreadSpecPublishedEvent } from '../threads/ingest/thread-spec-published.event';
import { FleetFlowsService } from './fleet-flows.service';

@Injectable()
@SystemWriter('system.flow.respec')
export class FleetFlowPublishListener {
  constructor(private readonly flows: FleetFlowsService) {}

  // The emitting ingest owns best-effort logging; let emitAsync observe a listener failure.
  @OnEvent(THREAD_SPEC_PUBLISHED, { suppressErrors: false })
  async onThreadSpecPublished(event: ThreadSpecPublishedEvent): Promise<void> {
    await runAsSystemWriter(this, () => this.flows.respec(event));
  }
}
