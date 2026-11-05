import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../../approvals/approval-command.registry';
import { parseBody } from '../../approvals/route/parse-body';
import { parseRouteInput } from '../../approvals/route/parse-route-input';
import { redactSecret } from '../../approvals/route/redact-secret';
import { routeCommand } from '../../approvals/route/route-command';
import { ActorPrincipalLoader } from '../../auth/principal/actor-principal.loader';
import {
  CreateProjectProviderCredentialDto,
  CreateProviderCredentialDto,
  ProviderCredentialDto,
  UpdateProviderCredentialDto,
} from './dto/provider-credential.dto';
import { ProviderCredentialsService } from './provider-credentials.service';

export const PROVIDER_CREDENTIAL_ROUTE_VARIANTS = {
  create: 'rest:fleet-provider-credentials.create', update: 'rest:fleet-provider-credentials.update', delete: 'rest:fleet-provider-credentials.delete',
} as const;

/**
 * US-005: the project route's own variants. They are separate commands from the GLOBAL ones because
 * the project key is separate: an approval for `fleet.credential.create` never runs a project write,
 * and the pinned `projectId` in the stored input is what a redemption has to match.
 */
export const PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS = {
  create: 'rest:project-provider-credentials.create',
  update: 'rest:project-provider-credentials.update',
  delete: 'rest:project-provider-credentials.delete',
} as const;

/** What a gated project write pins: the project the route resolved, and the row it names. */
interface ProjectCredentialPinned { projectId: string; id: string }

interface ProjectUpdateInput extends ProjectCredentialPinned { patch: UpdateProviderCredentialDto }

/** The project create's parsed input: the pinned project, then the body that decides the scope. */
interface ProjectCreateInput {
  projectId: string;
  providerId: string;
  name: string;
  key: string;
  repoId: string | null;
}

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

    // ---- US-005: the project routes. ----
    // The project is pin input, not posture: `projectId` is parsed out of the frozen input, so the
    // command writes into the project the route resolved and a redemption for another project's
    // request cannot match the hash. `parseBody` drops the undeclared `projectId` from the body it
    // validates, so the pinned id and the body never disagree.
    this.commands.register(routeCommand<ProjectCreateInput, ProviderCredentialDto>({
      key: 'project.credential.create', variant: PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.create,
      parse: (input) => {
        const { projectId } = parseRouteInput(input, ['projectId']);
        const body = parseBody(CreateProjectProviderCredentialDto, input);
        return { projectId, providerId: body.providerId, name: body.name, key: body.key, repoId: body.repoId ?? null };
      },
      redeem: {
        redact: ({ projectId, providerId, name, key, repoId }) => ({
          projectId, providerId, name, key: redactSecret(key), repoId,
        }),
      },
      run: (principal, input) => this.credentials.createProject(principal.id, input.projectId, input),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<ProjectUpdateInput, ProviderCredentialDto>({
      key: 'project.credential.update', variant: PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.update,
      parse: (input) => {
        const { projectId, id } = parseRouteInput(input, ['projectId', 'id']);
        return { projectId, id, patch: parseBody(UpdateProviderCredentialDto, (input as Record<string, unknown>).patch ?? {}) };
      },
      redeem: { redact: ({ projectId, id, patch }) => {
        const { key, ...rest } = patch;
        return { projectId, id, patch: key === undefined ? rest : { ...rest, key: redactSecret(key) } };
      } },
      run: (principal, input) => this.credentials.updateProject(input.projectId, input.id, { ...input.patch, updatedById: principal.id }),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<ProjectCredentialPinned, null>({
      key: 'project.credential.delete', variant: PROJECT_PROVIDER_CREDENTIAL_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['projectId', 'id']), redeem: {},
      run: async (principal, input) => {
        await this.credentials.removeProject(input.projectId, input.id, principal.id);
        return null;
      },
    }, this.loader));
  }
}
