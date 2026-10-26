import { Inject, Injectable } from '@nestjs/common';
import { currentContext, runWithActionContext, type ActionApproval } from '../action-context/action-context';
import { findCatalogEntry } from '../permissions/catalog';
import { ApprovalCommandRegistry } from './approval-command.registry';
import { ApprovalPolicyResolver, type ApprovalSubject } from './approval-policy.resolver';
import { APPROVAL_REQUEST_REPOSITORY, type ApprovalRequestRecord } from './domain/approval.domain';
import { UnregisteredApprovalCommandError } from './domain/approval.errors';
import type { PrismaApprovalRequestRepository } from './prisma-approval-request.repository';

export type GateOutcome<TResult> =
  | { status: 'executed'; result: TResult; approval: ActionApproval }
  | { status: 'pending'; request: ApprovalRequestRecord };

@Injectable()
export class ApprovalGate {
  constructor(
    private readonly registry: ApprovalCommandRegistry,
    @Inject(ApprovalPolicyResolver) private readonly resolver: Pick<ApprovalPolicyResolver, 'resolve'>,
    // Reserved for the pending-request branch (US-009); immediate execution never writes a request.
    @Inject(APPROVAL_REQUEST_REPOSITORY) _requests: Pick<PrismaApprovalRequestRepository, 'create'>,
  ) {}

  async gate<TResult>(
    key: string,
    input: unknown,
    opts: { projectId: string | null },
    _now?: Date,
  ): Promise<GateOutcome<TResult>> {
    const command = this.registry.get(key);
    if (command === undefined) throw new UnregisteredApprovalCommandError(key);

    const context = currentContext();
    if (context === undefined) throw new Error('approval gate needs an action context');

    const { actor } = context;
    let subject: ApprovalSubject;
    if (actor.type === 'USER' || actor.type === 'AGENT') {
      subject = { type: actor.type, id: actor.id };
    } else if (actor.type === 'SYSTEM' && actor.id === 'assistant' && context.onBehalfOf !== undefined) {
      subject = { type: 'ASSISTANT', id: 'assistant' };
    } else {
      throw new Error(`approval gate cannot gate actor ${actor.type}/${actor.id}`);
    }

    const parsed = command.parse(input);
    if (parsed === undefined || parsed === null) throw new Error(`approval command parse returned no input: ${key}`);
    if (findCatalogEntry(key)?.scope === 'project' && opts.projectId === null) {
      throw new Error(`approval gate needs a project for key ${key}`);
    }

    const resolved = await this.resolver.resolve({ key, projectId: opts.projectId, subject });
    let approval: ActionApproval;
    if (resolved.mode === 'none') {
      approval = { requiredMode: 'none', satisfiedBy: 'none' };
    } else if (subject.type === 'USER') {
      // Direct humans satisfy every mode, regardless of request-decision policy flags.
      approval = { requiredMode: resolved.mode, satisfiedBy: 'human', approverType: 'USER', approverId: actor.id };
    } else {
      // Fail closed until US-009 adds request creation; never execute an unapproved command.
      throw new Error('approval gate pending requests are not implemented');
    }

    const result = await runWithActionContext({ ...context, approval }, () => command.execute(parsed));
    // The registry erases result types; the caller chooses TResult for its registered command.
    return { status: 'executed', result: result as TResult, approval };
  }
}
