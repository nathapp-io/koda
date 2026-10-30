import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ValidationAppException } from '@nathapp/nestjs-common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseBody } from '../approvals/route/parse-body';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { redactSecret } from '../approvals/route/redact-secret';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { VCS_CFG, type IVcsConfig } from '../config/vcs.config';
import { VcsConnectionService } from './vcs-connection.service';
import type { ApplyPrStatusesResult } from './vcs-pr-sync.service';
import { VcsManualSync } from './vcs-manual-sync.service';
import { CreateVcsConnectionDto } from './dto/create-vcs-connection.dto';
import { UpdateVcsConnectionDto } from './dto/update-vcs-connection.dto';
import {
  VcsConnectionCreatedResponseDto,
  VcsConnectionUpdatedResponseDto,
  WebhookSecretResponseDto,
} from './dto/vcs-connection-response.dto';
import { SyncResultDto } from './dto/sync-result.dto';
import { TestConnectionResultDto } from './dto/test-connection-result.dto';

export const VCS_ROUTE_VARIANTS = { create: 'rest:vcs.create', update: 'rest:vcs.update', delete: 'rest:vcs.delete', test: 'rest:vcs.test', rotateWebhookSecret: 'rest:vcs.rotate-webhook-secret', syncIssue: 'rest:vcs.sync-issue', syncAll: 'rest:vcs.sync-all', syncPr: 'rest:vcs.sync-pr' } as const;

/** What a gated update/rotate call pins: the connection the handler read before the gate. */
interface ConnectionPinned { slug: string; projectId: string; connectionId: string }

interface UpdateVcsInput extends ConnectionPinned { patch: UpdateVcsConnectionDto }

@Injectable()
export class VcsRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly vcs: VcsConnectionService,
    private readonly loader: ActorPrincipalLoader,
    @Inject(VCS_CFG) private readonly vcsConfig: IVcsConfig,
    private readonly manualSync: VcsManualSync,
  ) {}

  onModuleInit(): void {
    // `gate-secret` (US-002): the request stores the redacted connection, so no token reaches the row,
    // the hash or a decider. Approving runs nothing; the requester redeems it by re-sending the body,
    // and the token that lands is the one in that re-sent body.
    this.commands.register(routeCommand<{ slug: string; projectId: string; connection: CreateVcsConnectionDto }, VcsConnectionCreatedResponseDto>({
      key: 'vcs.connection.create', variant: VCS_ROUTE_VARIANTS.create,
      parse: (input) => {
        const { slug, projectId } = parseRouteInput(input, ['slug', 'projectId']);
        const source = input as Record<string, unknown>;
        return { slug, projectId, connection: parseBody(CreateVcsConnectionDto, source.connection ?? {}) };
      },
      redeem: {
        redact: ({ slug, projectId, connection }) => ({
          slug, projectId, connection: { ...connection, token: redactSecret(connection.token) },
        }),
      },
      run: (_principal, input) => {
        const key = this.vcsConfig.encryptionKey;
        if (!key) throw new ValidationAppException({}, 'vcs');
        return this.vcs.create(input.projectId, key, input.connection);
      },
      // The generated secret leaves the server once, in this call's answer (M9); the request keeps the
      // connection alone.
      toResult: ({ webhookSecret: _webhookSecret, ...result }) => result,
    }, this.loader));
    // `gate-secret` (US-003): the request pins the connection the handler read before the gate, so a
    // connection deleted and recreated between approval and redemption cannot be the one changed. The
    // patch stores its token redacted; a token the caller did not send is absent, never a marker.
    this.commands.register(routeCommand<UpdateVcsInput, VcsConnectionUpdatedResponseDto>({
      key: 'vcs.connection.update', variant: VCS_ROUTE_VARIANTS.update,
      parse: (input) => {
        const { slug, projectId, connectionId } = parseRouteInput(input, ['slug', 'projectId', 'connectionId']);
        const source = input as Record<string, unknown>;
        return { slug, projectId, connectionId, patch: parseBody(UpdateVcsConnectionDto, source.patch ?? {}) };
      },
      redeem: {
        redact: ({ slug, projectId, connectionId, patch }) => {
          // A token the caller did not send is absent from the stored patch, never a marker: `parse`
          // hands the DTO's own (undefined) property, and only a real value is redacted.
          const { token, ...rest } = patch;
          return {
            slug, projectId, connectionId,
            patch: token === undefined ? rest : { ...rest, token: redactSecret(token) },
          };
        },
      },
      run: (_principal, input) => {
        const key = this.vcsConfig.encryptionKey;
        if (!key) throw new ValidationAppException({}, 'vcs');
        return this.vcs.update(input.projectId, key, input.patch, input.connectionId);
      },
      // A secret generated for a legacy row leaves the server once, in this call's answer (M9).
      toResult: ({ webhookSecret: _webhookSecret, ...result }) => result,
    }, this.loader));
    this.commands.register(routeCommand<ConnectionPinned, WebhookSecretResponseDto>({
      key: 'vcs.webhook-secret.rotate', variant: VCS_ROUTE_VARIANTS.rotateWebhookSecret,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'connectionId']),
      // No secret in the input, so nothing to redact: the empty `redeem` is what makes an approval
      // only release the request instead of running the rotation.
      redeem: {},
      run: (_principal, input) => this.vcs.rotateWebhookSecret(input.projectId, input.connectionId),
      // The rotated secret leaves the server once, in this call's answer (M9); the request keeps the
      // fact that it happened, nothing more.
      toResult: () => ({ rotated: true }),
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; projectId: string }, ApplyPrStatusesResult>({
      key: 'vcs.sync.pr', variant: VCS_ROUTE_VARIANTS.syncPr,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId']),
      run: (_principal, input) => this.manualSync.syncPr(input.slug),
      prepare: (_principal, input) => this.manualSync.prepareSyncPr(input.slug),
      afterCommit: (_principal, _input, result) => this.manualSync.startPrExtractions(result),
      toResult: (result) => ({ updated: result.updated }),
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; projectId: string; issueNumber: string }, SyncResultDto>({
      key: 'vcs.sync.issue', variant: VCS_ROUTE_VARIANTS.syncIssue,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId', 'issueNumber']),
      run: (_principal, input) => this.manualSync.syncIssue(input.slug, input.issueNumber),
      prepare: (_principal, input) => this.manualSync.prepareSyncIssue(input.slug, input.issueNumber),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ slug: string; projectId: string }, SyncResultDto>({
      key: 'vcs.sync.all', variant: VCS_ROUTE_VARIANTS.syncAll,
      parse: (input) => parseRouteInput(input, ['slug', 'projectId']),
      run: (_principal, input) => this.manualSync.syncAll(input.slug),
      prepare: (_principal, input) => this.manualSync.prepareSyncAll(input.slug),
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ projectId: string }, null>({
      key: 'vcs.connection.delete', variant: VCS_ROUTE_VARIANTS.delete,
      parse: (input) => parseRouteInput(input, ['projectId']),
      run: async (_principal, input) => {
        await this.vcs.delete(input.projectId);
        return null;
      },
    }, this.loader));
    this.commands.register(routeCommand<{ projectId: string }, TestConnectionResultDto>({
      key: 'vcs.connection.test', variant: VCS_ROUTE_VARIANTS.test,
      parse: (input) => parseRouteInput(input, ['projectId']),
      prepare: (_principal, input) => {
        const key = this.vcsConfig.encryptionKey;
        if (!key) throw new ValidationAppException({}, 'vcs');
        return this.vcs.prepareTestConnection(input.projectId, key);
      },
      run: (_principal, input) => {
        const key = this.vcsConfig.encryptionKey;
        if (!key) throw new ValidationAppException({}, 'vcs');
        return this.vcs.testConnection(input.projectId, key);
      },
      toResult: (result) => result,
    }, this.loader));
  }
}
