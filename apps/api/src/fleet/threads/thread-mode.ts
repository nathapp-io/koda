import { ValidationAppException } from '@nathapp/nestjs-common';
import type { ThreadMode } from '../common/thread-jobs';

export function validateThreadMode(value: unknown): ThreadMode {
  if (value !== 'read' && value !== 'ask' && value !== 'full') {
    throw new ValidationAppException({ reason: 'mode' }, 'threads.input');
  }
  return value;
}

export function threadModeKey(mode: ThreadMode): 'thread.cap.update' | 'thread.mode.ask' | 'thread.mode.full' {
  return mode === 'read' ? 'thread.cap.update' : `thread.mode.${mode}`;
}
