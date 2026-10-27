import { describe, expect, it, vi } from 'vitest';
import { FleetShellEscalateCommand } from './fleet-shell-escalate.command';

describe('FleetShellEscalateCommand', () => {
  const command = new FleetShellEscalateCommand({ lockById: vi.fn(), createCommand: vi.fn() } as never, {} as never, {} as never, {} as never);
  const input = { jobId: 'job', leaseEpoch: 0, naxAskId: 'ask', payload: { options: ['allow', 'allow-remember'] } };

  it('validates and projects the input', () => {
    expect(command.parse({ ...input, extra: true })).toEqual(input);
    expect(() => command.parse({ ...input, leaseEpoch: 1.5 })).toThrow();
  });
  it('parses bash approvals, including an idempotent parsed decision', () => {
    const result = { choice: 'allow_for_job', option: 'allow-remember' } as const;
    expect(command.parseDecision('approve', undefined, input)).toEqual({ choice: 'allow', option: 'allow' });
    expect(command.parseDecision('approve', result, input)).toEqual(result);
  });
  it('rejects unavailable choices, truncated commands and malformed rejects', () => {
    expect(() => command.parseDecision('approve', { choice: 'allow' }, { ...input, payload: { commandTruncated: true } })).toThrow();
    expect(() => command.parseDecision('approve', { choice: 'allow_for_job' }, { ...input, payload: { options: ['allow'] } })).toThrow();
    expect(() => command.parseDecision('reject', { choice: 'allow' }, input)).toThrow();
    expect(command.parseDecision('reject', undefined, input)).toEqual({ choice: 'deny', option: 'deny' });
  });
});
