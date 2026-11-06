import { ForbiddenAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { KodaPrincipal } from '../../auth/principal/koda-principal.types';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import type { ThreadPreApproval } from '../threads/domain/chat-thread.domain';
import { ThreadsService } from '../threads/threads.service';

export const THREAD_PREAPPROVAL_ROUTE_VARIANTS = {
  set: 'rest:fleet-thread-preapproval.set',
  clear: 'rest:fleet-thread-preapproval.clear',
} as const;

interface SetPreApprovalInput { projectId: string; threadId: string; costCapUsd: string }
interface ClearPreApprovalInput { projectId: string; threadId: string }

@Injectable()
export class FlowRouteCommands implements OnModuleInit {
  constructor(
    private readonly registry: ApprovalCommandRegistry,
    private readonly threads: ThreadsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.registry.register(routeCommand<SetPreApprovalInput, ThreadPreApproval>({
      key: 'fleet.thread.preapprove', variant: THREAD_PREAPPROVAL_ROUTE_VARIANTS.set,
      parse: parseSetInput,
      run: async (principal, input) => {
        assertHuman(principal);
        const thread = await this.threads.setPreApproval(input.projectId, input.threadId, principal.id, input.costCapUsd);
        if (!thread.preApproval) throw new Error('thread pre-approval write did not return its persisted value');
        return thread.preApproval;
      },
      toResult: (result) => result,
    }, this.loader));
    this.registry.register(routeCommand<ClearPreApprovalInput, null>({
      key: 'fleet.thread.preapprove', variant: THREAD_PREAPPROVAL_ROUTE_VARIANTS.clear,
      parse: (input) => parseRouteInput(input, ['projectId', 'threadId']),
      run: async (principal, input) => {
        assertHuman(principal);
        await this.threads.clearPreApproval(input.projectId, input.threadId);
        return null;
      },
    }, this.loader));
  }
}

function parseSetInput(value: unknown): SetPreApprovalInput {
  const { projectId, threadId } = parseRouteInput(value, ['projectId', 'threadId']);
  const cost = (value as Record<string, unknown>).costCapUsd;
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost <= 0 || cost > 1000 || Number(cost.toFixed(4)) !== cost) {
    throw new ValidationAppException({ reason: 'costCapUsd' }, 'threads.input');
  }
  return { projectId, threadId, costCapUsd: String(cost) };
}

function assertHuman(principal: KodaPrincipal): void {
  if (principal.actorType !== 'user') throw new ForbiddenAppException({}, 'fleet.flows.humanOnly');
}
