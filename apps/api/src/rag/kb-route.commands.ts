import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ApprovalCommandRegistry } from '../approvals/approval-command.registry';
import { parseRouteInput } from '../approvals/route/parse-route-input';
import { parseBody } from '../approvals/route/parse-body';
import { routeCommand } from '../approvals/route/route-command';
import { ActorPrincipalLoader } from '../auth/principal/actor-principal.loader';
import { DeleteKbDocumentQuery, type KbDeleteSource } from './dto/delete-kb-document.query';
import { KbDocumentDeletion } from './kb-document-deletion.service';

export const KB_ROUTE_VARIANTS = { delete: 'rest:kb-documents.delete' } as const;
interface KbDeleteInput { projectId: string; sourceId: string; source?: KbDeleteSource }

@Injectable()
export class KbRouteCommands implements OnModuleInit {
  constructor(
    private readonly commands: ApprovalCommandRegistry,
    private readonly deletion: KbDocumentDeletion,
    private readonly loader: ActorPrincipalLoader,
  ) {}

  onModuleInit(): void {
    this.commands.register(routeCommand<KbDeleteInput, { deleted: boolean }>({
      key: 'kb.document.delete', variant: KB_ROUTE_VARIANTS.delete,
      parse: input => {
        const ids = parseRouteInput(input, ['projectId', 'sourceId']);
        const query = parseBody(DeleteKbDocumentQuery, input);
        return { ...ids, ...query };
      },
      run: async (principal, input) => {
        await this.deletion.delete(principal, input.projectId, input.sourceId, input.source);
        return { deleted: true };
      },
      toResult: result => result,
    }, this.loader));
  }
}
