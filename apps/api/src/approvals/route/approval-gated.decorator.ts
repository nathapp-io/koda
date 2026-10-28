import {
  applyDecorators,
  Catch,
  SetMetadata,
  UseFilters,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { ApiExtraModels, ApiResponse, getSchemaPath } from '@nestjs/swagger';
import { JsonResponse } from '@nathapp/nestjs-common';
import { ApprovalRequestSummaryDto } from '../dto/approval-request.dto';
import { ApprovalPending } from './approval-pending';

/** Metadata a contract test reads to tell a gated handler from an ungated one (US-010). */
export const APPROVAL_GATED_METADATA = 'koda:approval-gated';

/**
 * US-003: answers a thrown `ApprovalPending` with 202 and the request summary.
 *
 * It goes through `HttpAdapterHost`, so the same filter works on Fastify (production) and Express.
 * `@Catch(ApprovalPending)` alone means every other error keeps travelling to the global filter.
 */
@Catch(ApprovalPending)
export class ApprovalPendingFilter implements ExceptionFilter<ApprovalPending> {
  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(error: ApprovalPending, host: ArgumentsHost): void {
    const { httpAdapter } = this.adapterHost;
    httpAdapter.reply(
      host.switchToHttp().getResponse(),
      JsonResponse.Ok(ApprovalRequestSummaryDto.from(error.request)),
      202,
    );
  }
}

/**
 * Marks a write handler as approval-gated: it may answer 202 with the pending request instead of
 * writing. Applied to the handler, so the filter runs before the global one, and documented here so
 * the operation's 202 shows up in the exported contract.
 */
export function ApprovalGated(): MethodDecorator {
  return applyDecorators(
    SetMetadata(APPROVAL_GATED_METADATA, true),
    UseFilters(ApprovalPendingFilter),
    ApiExtraModels(ApprovalRequestSummaryDto),
    ApiResponse({
      status: 202,
      description: 'The write waits for approval',
      schema: {
        type: 'object',
        properties: {
          ret: { type: 'number' },
          data: { $ref: getSchemaPath(ApprovalRequestSummaryDto) },
        },
      },
    }),
  );
}
