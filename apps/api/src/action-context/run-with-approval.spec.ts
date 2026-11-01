import { describe, expect, it } from 'vitest';
import { currentContext, runWithActionContext, runWithApproval, type ActionApproval } from './action-context';

const approval: ActionApproval = {
  requiredMode: 'human', satisfiedBy: 'human', approverType: 'FORGE_USER', approverId: 'github:alice',
};

describe('runWithApproval', () => {
  it('replaces approval while preserving actor and correlation, then restores the outer approval', async () => {
    const outerApproval = { requiredMode: 'none', satisfiedBy: 'none' } as const;
    await runWithActionContext({ actor: { type: 'SYSTEM', id: 'review' }, origin: 'system', approval: outerApproval, correlationId: 'c-1' }, async () => {
      await runWithApproval(approval, async () => {
        expect(currentContext()?.approval.approverId).toBe('github:alice');
        expect(currentContext()?.actor).toEqual({ type: 'SYSTEM', id: 'review' });
        expect(currentContext()?.correlationId).toBe('c-1');
        await Promise.resolve();
        expect(currentContext()?.approval.approverType).toBe('FORGE_USER');
      });
      expect(currentContext()?.approval).toBe(outerApproval);
    });
  });

  it('throws outside an action context', () => {
    expect(() => runWithApproval(approval, () => undefined)).toThrow('no action context');
  });
});
