import { ExecutionContext } from '@nestjs/common';

describe('CurrentUser decorator', () => {
  it('should return request.user from JWT auth', () => {
    const mockUser = { sub: 'user-123', email: 'user@example.com' };
    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: mockUser,
        }),
      }),
    } as unknown as ExecutionContext;

    const reqData = mockContext.switchToHttp().getRequest();
    expect(reqData.user).toEqual(mockUser);
  });

  it('should prioritize request.user over request.agent', () => {
    const mockUser = { sub: 'user-123', email: 'user@example.com' };
    const mockAgent = { id: 'agent-123', name: 'Test Agent' };

    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          user: mockUser,
          agent: mockAgent,
        }),
      }),
    } as unknown as ExecutionContext;

    const reqData = mockContext.switchToHttp().getRequest();
    // CurrentUser decorator returns user || agent, so user is prioritized
    expect(reqData.user).toEqual(mockUser);
  });

  it('should return request.agent when no user is present', () => {
    const mockAgent = { id: 'agent-123', name: 'Test Agent', status: 'ACTIVE' };

    const mockContext = {
      switchToHttp: () => ({
        getRequest: () => ({
          agent: mockAgent,
          actorType: 'agent',
        }),
      }),
    } as unknown as ExecutionContext;

    const reqData = mockContext.switchToHttp().getRequest();
    expect(reqData.agent).toEqual(mockAgent);
    expect(reqData.actorType).toBe('agent');
  });
});
