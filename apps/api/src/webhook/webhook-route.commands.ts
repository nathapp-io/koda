import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseBody } from '../approvals/route/parse-body';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { redactSecret } from '../approvals/route/redact-secret';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { WebhookService } from './webhook.service';
import { CreateWebhookDto, UpdateWebhookDto } from './webhook.dto';
import type { WebhookDomain, WebhookView } from './domain/webhook.domain';

export const WEBHOOK_ROUTE_VARIANTS = {
  create: 'rest:project-webhooks.create',
  update: 'rest:project-webhooks.update',
  projectDelete: 'rest:project-webhooks.delete',
  globalDelete: 'rest:webhooks.delete',
} as const;

interface CreateWebhookInput { slug: string; projectId: string; webhook: CreateWebhookDto }

interface UpdateWebhookInput { slug: string; projectId: string; id: string; patch: UpdateWebhookDto }

@Injectable()
export class WebhookRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly webhooks: WebhookService,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    // `gate-secret` (US-004): the request stores the webhook with its secret redacted (an unsent secret
    // stays absent), the URL guard runs in `prepare` — never inside the execution transaction — and the
    // generated secret leaves the server once, in this call's answer, not in the request row.
    this.commands.register(routeCommand<CreateWebhookInput, WebhookDomain>({
      key: 'webhook.create', variant: WEBHOOK_ROUTE_VARIANTS.create,
      parse: (input) => {
        const { slug, projectId } = parseRouteInput(input, ['slug', 'projectId']);
        const source = input as Record<string, unknown>;
        return { slug, projectId, webhook: parseBody(CreateWebhookDto, source.webhook ?? {}) };
      },
      redeem: {
        redact: ({ slug, projectId, webhook }) => {
          const { secret, ...rest } = webhook;
          return { slug, projectId, webhook: secret === undefined ? rest : { ...rest, secret: redactSecret(secret) } };
        },
      },
      prepare: (_principal, input) => this.webhooks.prepareCreate(input.projectId, input.webhook),
      run: (_principal, input) => this.webhooks.create(input.projectId, input.webhook),
      toResult: ({ secret: _secret, ...result }) => result,
    }, this.loader));
    // `gate-secret` (US-004): the patch stores its secret redacted; `prepare` checks ownership and an
    // optional URL, and its callback re-reads the webhook so a deleted one is a 404, not an update.
    this.commands.register(routeCommand<UpdateWebhookInput, WebhookView>({
      key: 'webhook.update', variant: WEBHOOK_ROUTE_VARIANTS.update,
      parse: (input) => {
        const { slug, projectId, id } = parseRouteInput(input, ['slug', 'projectId', 'id']);
        const source = input as Record<string, unknown>;
        return { slug, projectId, id, patch: parseBody(UpdateWebhookDto, source.patch ?? {}) };
      },
      redeem: {
        redact: ({ slug, projectId, id, patch }) => {
          const { secret, ...rest } = patch;
          return { slug, projectId, id, patch: secret === undefined ? rest : { ...rest, secret: redactSecret(secret) } };
        },
      },
      prepare: (_principal, input) => this.webhooks.prepareUpdate(input.projectId, input.id, input.patch),
      run: (_principal, input) => this.webhooks.update(input.projectId, input.id, input.patch),
      // The view has no secret to strip: the update never answers one.
      toResult: (result) => result,
    }, this.loader));
    this.commands.register(routeCommand<{ projectId: string; id: string }, null>({
      key: 'webhook.delete', variant: WEBHOOK_ROUTE_VARIANTS.projectDelete,
      parse: (input) => parseRouteInput(input, ['projectId', 'id']),
      run: async (_principal, input) => {
        await this.webhooks.removeForProject(input.projectId, input.id);
        return null;
      },
    }, this.loader));
    this.commands.register(routeCommand<{ id: string }, null>({
      key: 'webhook.delete', variant: WEBHOOK_ROUTE_VARIANTS.globalDelete,
      parse: (input) => parseRouteInput(input, ['id']),
      run: async (_principal, input) => {
        await this.webhooks.remove(input.id);
        return null;
      },
    }, this.loader));
  }
}
