export interface ApprovalPendingRequest {
  id: string;
  permissionKey: string;
  requiredMode: string;
  expiresAt: string;
  status: string;
}

export class ApprovalPendingError extends Error {
  readonly request: ApprovalPendingRequest;

  constructor(request: ApprovalPendingRequest) {
    super(`approval pending: ${request.id}`);
    this.name = 'ApprovalPendingError';
    this.request = request;
  }
}
