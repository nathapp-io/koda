// Runtime import of the package is allowed in a spec (protocol.spec.ts pins the rule for production code only).
import * as pkg from '@nathapp/fleet-protocol';
import * as apiThreads from './thread-jobs';
import { FleetCommandType } from '../../common/enums';

describe('thread job kind (US-001)', () => {
  it('US-001: isThreadKind("THREAD") returns true', () => {
    expect(apiThreads.isThreadKind('THREAD')).toBe(true);
  });

  it('US-001: isThreadKind("RUN") returns false', () => {
    expect(apiThreads.isThreadKind('RUN')).toBe(false);
  });

  it('US-001: isThreadKind rejects a lowercase variant and a config kind', () => {
    expect(apiThreads.isThreadKind('thread')).toBe(false);
    expect(apiThreads.isThreadKind('CONFIG_EDIT')).toBe(false);
  });

  it('US-001: the package and the API mirror agree on the thread job kind', () => {
    expect(apiThreads.THREAD_JOB_KIND).toBe(pkg.THREAD_JOB_KIND);
    expect(pkg.isThreadKind('THREAD')).toBe(true);
    expect(pkg.isThreadKind('RUN')).toBe(false);
  });
});

describe('chat thread kinds (US-001)', () => {
  it('US-001 AC1: the API CHAT_THREAD_KINDS deep-equals the package CHAT_THREAD_KINDS', () => {
    expect(apiThreads.CHAT_THREAD_KINDS).toEqual(pkg.CHAT_THREAD_KINDS);
  });

  it('US-001 AC1: the shared chat thread kinds are REPO then PROJECT', () => {
    expect(pkg.CHAT_THREAD_KINDS).toEqual(['REPO', 'PROJECT']);
  });
});

describe('thread command types (US-001)', () => {
  it('US-001: the API THREAD_COMMAND_TYPES deep-equals the package THREAD_COMMAND_TYPES', () => {
    expect(apiThreads.THREAD_COMMAND_TYPES).toEqual(pkg.THREAD_COMMAND_TYPES);
  });

  it('US-001: the package declares the five thread command types in protocol order', () => {
    expect(pkg.THREAD_COMMAND_TYPES).toEqual(['THREAD_INPUT', 'THREAD_ANSWER', 'THREAD_STOP_TURN', 'THREAD_CLOSE', 'THREAD_PUBLISH']);
  });

  it('US-001: FleetCommandType includes each of the five thread command types', () => {
    const values = Object.values(FleetCommandType);
    for (const type of apiThreads.THREAD_COMMAND_TYPES) {
      expect(values).toContain(type);
    }
  });
});

describe('thread stream constants (US-002)', () => {
  it('US-002 AC13: the API stream constants deep-equal the package constants', () => {
    const protocol = pkg as typeof pkg & {
      THREAD_STREAM: string;
      THREAD_STREAM_LIMITS: { lineMaxBytes: number; streamMaxBytes: number };
    };
    expect(apiThreads.THREAD_STREAM).toBe(protocol.THREAD_STREAM);
    expect(apiThreads.THREAD_STREAM_LIMITS).toEqual(protocol.THREAD_STREAM_LIMITS);
    expect(apiThreads.THREAD_STREAM_LIMITS).toEqual({ lineMaxBytes: 65_536, streamMaxBytes: 209_715_200 });
  });
});

describe('thread limits (US-001)', () => {
  it('US-001: the API THREAD_LIMITS deep-equals the package THREAD_LIMITS', () => {
    expect(apiThreads.THREAD_LIMITS).toEqual(pkg.THREAD_LIMITS);
  });

  it('US-001: the package THREAD_LIMITS holds the pinned protocol caps', () => {
    expect(pkg.THREAD_LIMITS).toEqual({ messageMaxBytes: 32768, maxNativeModels: 32, maxAcpAgents: 8, maxArchivedThreadIds: 100 });
  });
});

describe('project code limits (US-001 AC1)', () => {
  it('US-001 AC1: the API PROJECT_CODE_LIMITS deep-equals the package PROJECT_CODE_LIMITS', () => {
    expect(apiThreads.PROJECT_CODE_LIMITS).toEqual(pkg.PROJECT_CODE_LIMITS);
  });

  it('US-001 AC1: the shared limits are { maxRepos: 10, maxUnavailable: 50 }', () => {
    expect(apiThreads.PROJECT_CODE_LIMITS).toEqual({ maxRepos: 10, maxUnavailable: 50 });
    expect(pkg.PROJECT_CODE_LIMITS).toEqual({ maxRepos: 10, maxUnavailable: 50 });
  });
});

describe('MODEL_ID_RE (US-001)', () => {
  it.each([['deepseek-v3'], ['gpt-4o'], ['anthropic/claude-3.5@beta:v1'], ['a'], ['a'.repeat(128)]])('accepts the model id %s', (id) => {
    expect(apiThreads.MODEL_ID_RE.test(id)).toBe(true);
  });

  it.each([['bad model'], ['-leading-dash'], ['a'.repeat(129)], [''], ['models;rm']])('rejects the model id %s', (id) => {
    expect(apiThreads.MODEL_ID_RE.test(id)).toBe(false);
  });
});
