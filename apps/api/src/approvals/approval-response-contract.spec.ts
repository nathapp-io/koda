import 'reflect-metadata';
const API_RESPONSE_METADATA = 'swagger/apiResponse';
import { ApprovalPoliciesController } from './approval-policies.controller';
import { ProjectApprovalPoliciesController } from './project-approval-policies.controller';
import { ApprovalRequestsController } from './approval-requests.controller';

const schema = (handler: Function, status: number) =>
  Reflect.getMetadata(API_RESPONSE_METADATA, handler)[status].schema;

describe('Approval response contracts', () => {
  it.each(['list', 'keys', 'create', 'update'] as const)('project policy %s matches the global envelope', (method) => {
    const status = method === 'create' ? 201 : 200;
    expect(schema(ProjectApprovalPoliciesController.prototype[method], status)).toEqual(
      schema(ApprovalPoliciesController.prototype[method], status),
    );
  });

  it('decision responses use the same request envelope as detail and cancel', () => {
    const expected = schema(ApprovalRequestsController.prototype.get, 200);
    expect(schema(ApprovalRequestsController.prototype.decide, 200)).toEqual(expected);
    expect(schema(ApprovalRequestsController.prototype.cancel, 200)).toEqual(expected);
  });
});
