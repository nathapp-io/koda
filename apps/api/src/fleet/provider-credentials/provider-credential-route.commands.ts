import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseBody } from '../../approvals/route/parse-body';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { redactSecret } from '../../approvals/route/redact-secret';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import { CreateProviderCredentialDto, ProviderCredentialDto, UpdateProviderCredentialDto } from './dto/provider-credential.dto';
import { ProviderCredentialsService } from './provider-credentials.service';

export const PROVIDER_CREDENTIAL_ROUTE_VARIANTS = {
  create: 'rest:fleet-provider-credentials.create', update: 'rest:fleet-provider-credentials.update', delete: 'rest:fleet-provider-credentials.delete',
} as const;

/**
 * The GLOBAL provider credential routes as approval commands (spec §"US-003"), following
 * `vcs.connection.create` exactly.
 *
 * `redeem.redact` replaces the key with `redactSecret(key)`, so no approval request row — nor the hash a
 * redemption has to match — ever carries a secret. Approving such a request runs nothing; the requester
 * redeems it by repeating the call with the key it actually wants sealed, and that body is what lands.
 * US-004 registers the update and delete variants here.
 */
@Injectable()
export class ProviderCredentialRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly credentials: ProviderCredentialsService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<CreateProviderCredentialDto, ProviderCredentialDto>({
      key: 'fleet.credential.create', variant: PROVIDER_CREDENTIAL_ROUTE_VARIANTS.create,
      parse: (input) => parseBody(CreateProviderCredentialDto, input),
      redeem: {
        redact: ({ providerId, name, key }) => ({ providerId, name, key: redactSecret(key) }),
      },
      run: (principal, input) => this.credentials.createGlobal(principal.id, input),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ id: string; patch: UpdateProviderCredentialDto }, ProviderCredentialDto>({
      key: 'fleet.credential.update', variant: PROVIDER_CREDENTIAL_ROUTE_VARIANTS.update,
      parse: (input) => {
        const { id } = parseRouteInput(input, ['id']);
        return { id, patch: parseBody(UpdateProviderCredentialDto, (input as Record<string, unknown>).patch ?? {}) };
      },
      redeem: { redact: ({ id, patch }) => {
        const { key, ...rest } = patch;
        return { id, patch: key === undefined ? rest : { ...rest, key: redactSecret(key) } };
      } },
      run: (principal, input) => this.credentials.updateGlobal(input.id, { ...input.patch, updatedById: principal.id }),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ id: string }, null>({
      key: 'fleet.credential.delete', variant: PROVIDER_CREDENTIAL_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['id']), redeem: {},
      run: async (principal, input) => { await this.credentials.removeGlobal(input.id, principal.id); return null; },
    }, this.loader));
  }
}
