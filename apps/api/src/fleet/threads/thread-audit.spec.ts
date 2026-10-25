import { describe, expect, it } from 'vitest';
import { threadAuditKey, type ThreadAuditAction } from './thread-audit';

describe('threadAuditKey', () => {
  it.each([
    ['create', 'thread.create', 'thread.workspace.create'],
    ['message', 'thread.message.send', 'thread.workspace.message.send'],
    ['archive', 'thread.archive', 'thread.workspace.archive'],
    ['cap', 'thread.cap.update', 'thread.cap.update'],
    ['stop', 'thread.stop', 'thread.stop'],
    ['end-session', 'thread.end-session', 'thread.end-session'],
    ['answer', 'thread.answer', 'thread.answer'],
    ['publish', 'thread.publish', 'thread.publish'],
    ['discard', 'thread.discard', 'thread.discard'],
  ] satisfies [ThreadAuditAction, string, string][])('maps %s in both scopes', (action, projectKey, workspaceKey) => {
    expect(threadAuditKey(action, false)).toBe(projectKey);
    expect(threadAuditKey(action, true)).toBe(workspaceKey);
  });
});
