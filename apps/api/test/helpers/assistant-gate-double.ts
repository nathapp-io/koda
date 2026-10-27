import { vi } from 'vitest';
import type { ApprovalGate } from '../../src/approvals/approval-gate.service';
import type { ApprovalPolicyResolver } from '../../src/approvals/approval-policy.resolver';
import type { AssistantActionRequestRepository } from '../../src/fleet/assistant/requests/assistant-action-request.domain';
import type { ThreadEventBus } from '../../src/live/thread-event-bus';
import type { ITransactionManager } from '@nathapp/nestjs-data';

/** Fresh per executor; tests may override each seam without sharing state. */
export function gateDouble(mode: 'human' | 'none' = 'human') {
  const gate = { gate: vi.fn(async () => ({ status: 'pending', request: { id: 'a1' } })) };
  const resolver = { resolve: vi.fn(async () => ({ mode })) };
  const links = { lockThread: vi.fn(async () => true), countPendingInThread: vi.fn(async () => 0), findByRequest: vi.fn(async () => null), insert: vi.fn(async (link: unknown) => link) };
  const bus = { publish: vi.fn() };
  const tx = { run: vi.fn((fn: () => Promise<unknown>) => fn()) };
  const deps = [gate as unknown as ApprovalGate, resolver as unknown as ApprovalPolicyResolver, links as unknown as AssistantActionRequestRepository, bus as unknown as ThreadEventBus, tx as unknown as ITransactionManager] as const;
  return { gate, resolver, links, bus, tx, deps };
}
