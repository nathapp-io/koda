export type ThreadAuditAction = 'create' | 'message' | 'archive' | 'cap' | 'stop' | 'end-session' | 'answer' | 'publish' | 'discard';

/** The catalog key a thread write records under; a workspace thread's create, message and archive have their own keys. */
export function threadAuditKey(action: ThreadAuditAction, workspace: boolean): string {
  if (workspace && (action === 'create' || action === 'message' || action === 'archive')) {
    return `thread.workspace.${action === 'message' ? 'message.send' : action}`;
  }

  switch (action) {
    case 'create': return 'thread.create';
    case 'message': return 'thread.message.send';
    case 'archive': return 'thread.archive';
    case 'cap': return 'thread.cap.update';
    case 'stop': return 'thread.stop';
    case 'end-session': return 'thread.end-session';
    case 'answer': return 'thread.answer';
    case 'publish': return 'thread.publish';
    case 'discard': return 'thread.discard';
  }
}
