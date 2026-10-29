/**
 * US-003 AC-12, AC-14 and AC-15 — a pending write leaves a gated handler as a thrown
 * `ApprovalPending`: Nest re-applies the route's static status after the interceptors, so only an
 * exception filter can answer 202. `@ApprovalGated()` attaches that filter and documents the answer.
 */
import 'reflect-metadata';
import { EXCEPTION_FILTERS_METADATA, FILTER_CATCH_EXCEPTIONS } from '@nestjs/common/constants';
import type { ArgumentsHost } from '@nestjs/common';
import { JsonResponse, ValidationAppException } from '@nathapp/nestjs-common';
import { getSchemaPath } from '@nestjs/swagger';
import type { HttpAdapterHost } from '@nestjs/core';
import type { ApprovalRequestRecord } from '../domain/approval.domain';
import { ApprovalRequestSummaryDto } from '../dto/approval-request.dto';
import { ApprovalPending } from './approval-pending';
import {
  APPROVAL_GATED_METADATA,
  ApprovalGated,
  ApprovalPendingFilter,
} from './approval-gated.decorator';

const API_RESPONSE_METADATA = 'swagger/apiResponse';

const record: ApprovalRequestRecord = {
  id: 'request', permissionKey: 'role.manage', projectId: null, actor: { type: 'AGENT', id: 'agent' },
  onBehalfOf: null, origin: 'rest', correlationId: 'correlation', input: { key: 'qa' }, inputHash: 'hash',
  requiredMode: 'human', policyId: null, onTimeout: 'reject', approverMustHoldAction: true,
  requireDistinctApprover: false, status: 'pending', satisfiedBy: null, approverType: null, approverId: null,
  expiresAt: new Date('2026-10-02T00:00:00.000Z'), decidedAt: null, settledAt: null, result: null,
  createdAt: new Date('2026-10-01T00:00:00.000Z'),
};

class GatedProbe {
  @ApprovalGated()
  create(): void {
    // The decorator's metadata is the subject; the body never runs.
  }

  @ApprovalGated({ redeem: true })
  redeem(): void {}
}

describe('ApprovalPending', () => {
  it('is an Error carrying the request and a message naming its id', () => {
    const pending = new ApprovalPending(record);

    expect(pending).toBeInstanceOf(Error);
    expect(Object.getPrototypeOf(pending)).toBe(ApprovalPending.prototype);
    expect(pending.name).toBe('ApprovalPending');
    expect(pending.message).toBe('approval pending: request');
    expect(pending.request).toBe(record);
  });
});

describe('ApprovalPendingFilter', () => {
  it('AC-12: replies 202 with the request summary envelope through the http adapter', () => {
    const reply = vi.fn();
    const response = { marker: 'response' };
    const host = { switchToHttp: () => ({ getResponse: () => response }) } as unknown as ArgumentsHost;
    const filter = new ApprovalPendingFilter({ httpAdapter: { reply } } as unknown as HttpAdapterHost);

    filter.catch(new ApprovalPending(record), host);

    expect(reply).toHaveBeenCalledWith(response, JsonResponse.Ok(ApprovalRequestSummaryDto.from(record)), 202);
  });

  it('catches only ApprovalPending, so no other error is answered 202', () => {
    const caught = Reflect.getMetadata(FILTER_CATCH_EXCEPTIONS, ApprovalPendingFilter);

    expect(caught).toEqual([ApprovalPending]);
  });
});

describe('@ApprovalGated()', () => {
  it('AC-14: marks the handler gated and attaches the pending filter', () => {
    const handler = GatedProbe.prototype.create;

    expect(Reflect.getMetadata(APPROVAL_GATED_METADATA, handler)).toBe(true);
    expect(Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, handler)).toEqual([ApprovalPendingFilter]);
  });

  it('AC-4: redeem option documents optional request header', () => {
    const headers = Reflect.getMetadata('swagger/apiParameters', GatedProbe.prototype.redeem) as Array<{ name: string; required: boolean }>;
    expect(headers).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'X-Koda-Approval-Request', in: 'header', required: false }),
    ]));
  });

  it('AC-5: no options adds no header metadata', () => {
    expect(Reflect.getMetadata('swagger/apiParameters', GatedProbe.prototype.create)).toBeUndefined();
  });

  it('AC-6: redeem handler retains gate, filter, and documented 202 response', () => {
    const handler = GatedProbe.prototype.redeem;
    expect(Reflect.getMetadata(APPROVAL_GATED_METADATA, handler)).toBe(true);
    expect(Reflect.getMetadata(EXCEPTION_FILTERS_METADATA, handler)).toEqual([ApprovalPendingFilter]);
    const responses = Reflect.getMetadata(API_RESPONSE_METADATA, handler) as Record<number, unknown>;
    expect(responses[202]).toBeDefined();
  });

  it('AC-7: exports the lower-case redeem header name', async () => {
    const { APPROVAL_REDEEM_HEADER } = await import('./approval-gated.decorator');
    expect(APPROVAL_REDEEM_HEADER).toBe('x-koda-approval-request');
  });

  it('REG-1: ValidationAppException is not caught by the pending filter', () => {
    expect(Reflect.getMetadata(FILTER_CATCH_EXCEPTIONS, ApprovalPendingFilter)).toEqual([ApprovalPending]);
    expect(new ValidationAppException({}, 'validation').getStatus()).toBe(400);
  });

  it('AC-15: documents the 202 answer with the request summary model', () => {
    const responses = Reflect.getMetadata(API_RESPONSE_METADATA, GatedProbe.prototype.create) as Record<
      number | string,
      { description?: string; schema?: { properties?: Record<string, { $ref?: string }> } }
    >;
    const pending = responses[202];

    expect(pending).toBeDefined();
    expect(pending.description).toBe('The write waits for approval');
    expect(pending.schema?.properties?.data?.$ref).toBe(getSchemaPath(ApprovalRequestSummaryDto));
    expect(pending.schema?.properties?.data?.$ref).toContain('ApprovalRequestSummaryDto');
    // The model must be in the document for the $ref to resolve.
    expect(Reflect.getMetadata('swagger/apiExtraModels', GatedProbe.prototype.create))
      .toContain(ApprovalRequestSummaryDto);
  });
});
