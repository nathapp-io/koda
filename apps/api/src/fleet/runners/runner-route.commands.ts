import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseBody } from '../../approvals/route/parse-body';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { RunnersService } from './runners.service';
import { RunnerDto } from './dto/runner.dto';
import { UpdateRunnerDto } from './dto/update-runner.dto';
import { EnrollmentService } from './enrollment.service';
import { CreateEnrollmentDto } from './dto/create-enrollment.dto';
import { EnrollmentCreatedDto } from './dto/enrollment.dto';

export const ENROLLMENT_ROUTE_VARIANTS = {
  create: 'rest:fleet-enrollments.create',
} as const;

export const RUNNER_ROUTE_VARIANTS = {
  update: 'rest:fleet-runners.update',
  delete: 'rest:fleet-runners.delete',
} as const;

@Injectable()
export class RunnerRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly runners: RunnersService,
    private readonly loader: ActorPrincipalLoader,
    private readonly enrollments: EnrollmentService,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<{ labels: string[] }, EnrollmentCreatedDto>({
      key: 'fleet.enrollment.create', variant: ENROLLMENT_ROUTE_VARIANTS.create,
      parse: (input) => {
        const { labels = [] } = parseBody(CreateEnrollmentDto, input);
        return { labels };
      },
      run: (principal, input) => this.enrollments.create(principal.id, input.labels),
      redeem: {},
      toResult: ({ token: _token, ...result }) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ id: string; patch: UpdateRunnerDto }, RunnerDto>({
      key: 'fleet.runner.update', variant: RUNNER_ROUTE_VARIANTS.update,
      parse: (input) => {
        const ids = parseRouteInput(input, ['id']);
        const { patch = {} } = input as { patch?: unknown };
        return { ...ids, patch: parseBody(UpdateRunnerDto, patch) };
      },
      run: (principal, input) => this.runners.update(principal.id, input.id, input.patch),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ id: string }, null>({
      key: 'fleet.runner.delete', variant: RUNNER_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['id']),
      run: async (principal, input) => {
        await this.runners.remove(principal.id, input.id);
        return null;
      },
    }, this.loader));
  }
}
