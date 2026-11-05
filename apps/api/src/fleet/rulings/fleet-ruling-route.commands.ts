import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseBody } from '../../approvals/route/parse-body';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { CreateRulingDto } from './dto/create-ruling.dto';
import { FleetPrRulingDto } from './dto/fleet-pr-ruling.dto';
import { FleetPrRulingsService } from './fleet-pr-rulings.service';

export const FLEET_RULING_ROUTE_VARIANTS = { create: 'rest:fleet.job.rule' } as const;
interface Input { slug: string; projectId: string; jobId: string; ruling: CreateRulingDto }

@Injectable()
export class FleetRulingRouteCommands implements OnModuleInit {
  constructor(private readonly commands: ApprovalCommandRegistry, private readonly rulings: FleetPrRulingsService, private readonly loader: ActorPrincipalLoader) {}
  onModuleInit(): void {
    this.commands.register(routeCommand<Input, FleetPrRulingDto>({
      key: 'fleet.job.rule', variant: FLEET_RULING_ROUTE_VARIANTS.create,
      parse: (input) => ({ ...parseRouteInput(input, ['slug', 'projectId', 'jobId']), ruling: parseBody(CreateRulingDto, (input as Record<string, unknown>).ruling ?? {}) }),
      run: async (principal, input) => {
        // US-014: the replay re-runs the same preflight (eligibility + item-index read) before create.
        await this.rulings.preflight(input.projectId, input.jobId, input.ruling);
        return FleetPrRulingDto.from(await this.rulings.create(principal, input.slug, input.jobId, input.ruling));
      },
      toResult: (result) => result,
    }, this.loader));
  }
}
