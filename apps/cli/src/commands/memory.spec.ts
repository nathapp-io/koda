jest.mock('chalk', () => ({
  cyan: { bold: (s: string) => s },
  gray: (s: string) => s,
  green: (s: string) => s,
  red: (s: string) => s,
  yellow: (s: string) => s,
}));

const mockData: Record<string, string> = {};
const mockStore = {
  get: jest.fn((key: string) => mockData[key] || ''),
  set: jest.fn((key: string, value: string) => { mockData[key] = value; }),
};
jest.mock('conf', () => jest.fn(() => mockStore));

jest.mock('../generated', () => ({
  timelineControllerGetTimeline: jest.fn(),
  memoryControllerRecordDecision: jest.fn(),
  memoryControllerCreateMemory: jest.fn(),
  memoryReadControllerGetMemory: jest.fn(),
  memoryControllerRetireDecision: jest.fn(),
  projectsControllerFindBySlug: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));

jest.mock('../config', () => ({
  resolveContext: jest.fn(),
}));

import { Command } from 'commander';
import { memoryCommand } from './memory';
import { timelineControllerGetTimeline, memoryControllerRecordDecision, memoryControllerCreateMemory, memoryReadControllerGetMemory, memoryControllerRetireDecision, projectsControllerFindBySlug } from '../generated';
import { resolveContext } from '../config';

const mockResolveContext = resolveContext as jest.Mock;
const mockGetTimeline = timelineControllerGetTimeline as jest.Mock;
const mockRecordDecision = memoryControllerRecordDecision as jest.Mock;
const mockCreateMemory = memoryControllerCreateMemory as jest.Mock;
const mockGetMemory = memoryReadControllerGetMemory as jest.Mock;
const mockRetireDecision = memoryControllerRetireDecision as jest.Mock;
const mockFindBySlug = projectsControllerFindBySlug as jest.Mock;

const CTX = { apiKey: 'sk-test', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };

describe('memoryCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    memoryCommand(program);
    mockResolveContext.mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('timeline', () => {
    const timelineEnvelope = {
      events: [{ id: 'e1', eventType: 'ticket_event', actorId: 'u-1', action: 'created', createdAt: '2026-01-01T00:00:00.000Z' }],
      nextCursor: 'abc',
    };

    it('fetches timeline and prints a table', async () => {
      mockGetTimeline.mockResolvedValue({ ret: 0, data: timelineEnvelope });

      await program.parseAsync(['node', 'koda', 'memory', 'timeline']);

      expect(mockGetTimeline).toHaveBeenCalledWith(expect.objectContaining({ path: expect.objectContaining({ slug: 'my-proj' })}));
      expect(logSpy.mock.calls.flat().join('\n')).toContain('--cursor abc');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json flag is set', async () => {
      mockGetTimeline.mockResolvedValue({ ret: 0, data: timelineEnvelope });

      await program.parseAsync(['node', 'koda', 'memory', 'timeline', '--json']);

      const parsed = JSON.parse(String(logSpy.mock.calls[0][0])) as Array<Record<string, unknown>>;
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.some((e) => e['id'] === 'e1')).toBe(true);
    });

    it('passes filter options to the API', async () => {
      mockGetTimeline.mockResolvedValue({ ret: 0, data: { events: [] } });

      await program.parseAsync([
        'node', 'koda', 'memory', 'timeline',
        '--actor-id', 'u-1',
        '--ticket-id', 't-1',
        '--from', '2026-01-01',
        '--to', '2026-06-01',
        '--limit', '10',
      ]);

      expect(mockGetTimeline).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ actorId: 'u-1', ticketId: 't-1', from: '2026-01-01', to: '2026-06-01', limit: 10 })}));
    });

    it('handles empty result gracefully', async () => {
      mockGetTimeline.mockResolvedValue({ ret: 0, data: { events: [] } });

      await program.parseAsync(['node', 'koda', 'memory', 'timeline', '--json']);

      expect(logSpy).toHaveBeenCalledWith('[]');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('decisions', () => {
    beforeEach(() => {
      mockFindBySlug.mockResolvedValue({ ret: 0, data: { id: 'proj-cuid-1' } });
    });

    it('resolves the project slug to an ID and records the decision', async () => {
      mockRecordDecision.mockResolvedValue({ ret: 0, data: { id: 'decision-1' } });

      await program.parseAsync([
        'node', 'koda', 'memory', 'decisions',
        '--actor-id', 'agent-1',
        '--topic', 'auth approach',
        '--decision', 'use JWT',
        '--rationale', 'simplest for now',
      ]);

      expect(mockFindBySlug).toHaveBeenCalledWith({ path: { slug: 'my-proj' }});
      expect(mockRecordDecision).toHaveBeenCalledWith({ body: {
          projectId: 'proj-cuid-1',
          actorId: 'agent-1',
          topic: 'auth approach',
          decision: 'use JWT',
          rationale: 'simplest for now',
          sourceId: undefined,
        }});
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON with --json flag', async () => {
      mockRecordDecision.mockResolvedValue({ ret: 0, data: { id: 'decision-2' } });

      await program.parseAsync([
        'node', 'koda', 'memory', 'decisions',
        '--actor-id', 'agent-1',
        '--topic', 't',
        '--decision', 'd',
        '--json',
      ]);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ id: 'decision-2' }, null, 2));
    });

    it('omits actorId when --actor-id is not provided (server attributes it to the caller)', async () => {
      mockRecordDecision.mockResolvedValue({ ret: 0, data: { id: 'decision-3' } });

      await program.parseAsync([
        'node', 'koda', 'memory', 'decisions',
        '--topic', 't',
        '--decision', 'd',
      ]);

      expect(mockRecordDecision).toHaveBeenCalledWith({ body: expect.objectContaining({ actorId: undefined })});
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });

  describe('retire', () => {
    it('calls the generated retire operation with the ID and empty body without a project slug', async () => {
      mockResolveContext.mockResolvedValueOnce({ apiKey: 'sk-test', apiUrl: 'http://localhost:3100/api' });
      mockRetireDecision.mockResolvedValue({ ret: 0, data: { id: 'm1' } });

      await program.parseAsync(['node', 'koda', 'memory', 'retire', 'm1']);

      expect(mockRetireDecision).toHaveBeenCalledWith({ path: { id: 'm1' }, body: {} });
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('sends the supplied reason', async () => {
      mockRetireDecision.mockResolvedValue({ ret: 0, data: { id: 'm1' } });

      await program.parseAsync(['node', 'koda', 'memory', 'retire', 'm1', '--reason', 'wrong call']);

      expect(mockRetireDecision).toHaveBeenCalledWith({ path: { id: 'm1' }, body: { reason: 'wrong call' } });
    });

    it('prints a success message by default', async () => {
      mockRetireDecision.mockResolvedValue({ ret: 0, data: { id: 'm1' } });

      await program.parseAsync(['node', 'koda', 'memory', 'retire', 'm1']);

      expect(logSpy).toHaveBeenCalledWith('Decision retired.');
    });

    it('prints the response data as JSON when requested', async () => {
      mockRetireDecision.mockResolvedValue({ ret: 0, data: { id: 'm1', status: 'rejected' } });

      await program.parseAsync(['node', 'koda', 'memory', 'retire', 'm1', '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ id: 'm1', status: 'rejected' }, null, 2));
    });

    it('routes a 404 response through the API error handler', async () => {
      mockRetireDecision.mockRejectedValue(Object.assign(new Error('Not found'), {
        response: { status: 404, data: { message: 'Not found' } },
      }));

      await program.parseAsync(['node', 'koda', 'memory', 'retire', 'm1']);

      expect(exitSpy).toHaveBeenCalledWith(4);
      expect(mockRetireDecision).toHaveBeenCalledWith({ path: { id: 'm1' }, body: {} });
    });
  });

  describe('create', () => {
    beforeEach(() => {
      mockFindBySlug.mockResolvedValue({ ret: 0, data: { id: 'proj-cuid-1' } });
    });

    it('resolves the project slug to an ID and creates the memory item', async () => {
      mockCreateMemory.mockResolvedValue({ ret: 0, data: { id: 'mem-1' } });

      await program.parseAsync([
        'node', 'koda', 'memory', 'create',
        '--kind', 'FACT',
        '--subject', 'ticket-1',
        '--predicate', 'blocked-by',
        '--object', 'ticket-2',
        '--confidence', '0.9',
      ]);

      expect(mockFindBySlug).toHaveBeenCalledWith({ path: { slug: 'my-proj' }});
      expect(mockCreateMemory).toHaveBeenCalledWith({
        body: {
          projectId: 'proj-cuid-1',
          kind: 'FACT',
          scope: undefined,
          description: undefined,
          subject: 'ticket-1',
          predicate: 'blocked-by',
          object: 'ticket-2',
          sourceType: undefined,
          sourceId: undefined,
          confidence: 0.9,
          ownerId: undefined,
        },
      });
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON with --json flag', async () => {
      mockCreateMemory.mockResolvedValue({ ret: 0, data: { id: 'mem-2' } });

      await program.parseAsync([
        'node', 'koda', 'memory', 'create',
        '--kind', 'PREFERENCE',
        '--subject', 's',
        '--predicate', 'p',
        '--json',
      ]);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ id: 'mem-2' }, null, 2));
    });

    it('creates a NOTE with description and exits successfully', async () => {
      mockCreateMemory.mockResolvedValue({ ret: 0, data: { id: 'note-1' } });
      await program.parseAsync([
        'node', 'koda', 'memory', 'create', '--kind', 'NOTE', '--subject', 'replay-budget',
        '--predicate', 'project', '--object', 'body', '--description', 'replay budget',
      ]);
      expect(mockCreateMemory).toHaveBeenCalledWith({ body: expect.objectContaining({ kind: 'NOTE', description: 'replay budget' }) });
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('forwards user scope and rejects invalid scope before resolving context', async () => {
      mockCreateMemory.mockResolvedValue({ ret: 0, data: { id: 'note-2' } });
      await program.parseAsync([
        'node', 'koda', 'memory', 'create', '--kind', 'NOTE', '--subject', 's', '--predicate', 'p', '--description', 'd', '--scope', 'user',
      ]);
      expect(mockCreateMemory).toHaveBeenCalledWith({ body: expect.objectContaining({ scope: 'user' }) });
      expect(exitSpy).toHaveBeenCalledWith(0);

      jest.clearAllMocks();
      mockResolveContext.mockResolvedValue(CTX);
      await program.parseAsync([
        'node', 'koda', 'memory', 'create', '--kind', 'NOTE', '--subject', 's', '--predicate', 'p', '--scope', 'org',
      ]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --scope value: org'));
      expect(exitSpy).toHaveBeenCalledWith(3);
      expect(mockResolveContext).not.toHaveBeenCalled();
      expect(mockCreateMemory).not.toHaveBeenCalled();
    });

    it('prints create API failures to stderr and exits 1', async () => {
      mockCreateMemory.mockRejectedValue(Object.assign(new Error('create unavailable'), { statusCode: 500 }));
      await program.parseAsync(['node', 'koda', 'memory', 'create', '--kind', 'FACT', '--subject', 's', '--predicate', 'p']);
      expect(errorSpy).toHaveBeenCalledWith('✗ create unavailable');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('exits with code 3 on a non-numeric --confidence instead of silently defaulting', async () => {
      await program.parseAsync([
        'node', 'koda', 'memory', 'create',
        '--kind', 'FACT',
        '--subject', 's',
        '--predicate', 'p',
        '--confidence', 'not-a-number',
      ]);

      expect(mockCreateMemory).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(3);
    });
  });

  describe('list and search', () => {
    const page = { total: 1, current: 1, size: 20, hasNext: false, hasPrev: false, records: [
      { id: 'n1', kind: 'NOTE', scope: 'user', description: 'replay budget', subject: 'replay-budget' },
      { id: 'f1', kind: 'FACT', scope: 'project', subject: 'runner', predicate: 'deploys' },
    ] };

    it('lists a JSON page with filters and selected page', async () => {
      mockResolveContext.mockResolvedValueOnce({ ...CTX, projectSlug: 'alpha' });
      mockGetMemory.mockResolvedValue({ ret: 0, data: page });
      await program.parseAsync(['node', 'koda', 'memory', 'list', '--project', 'alpha', '--kind', 'NOTE', '--scope', 'user', '--page', '2', '--json']);
      expect(mockGetMemory).toHaveBeenCalledWith({ path: { slug: 'alpha' }, query: { kind: 'NOTE', scope: 'user', current: 2 } });
      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(page, null, 2));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('prints concise human records', async () => {
      mockGetMemory.mockResolvedValue({ ret: 0, data: page });
      await program.parseAsync(['node', 'koda', 'memory', 'list', '--project', 'alpha']);
      expect(logSpy.mock.calls.flat().join('\\n')).toContain('n1 NOTE user replay budget');
      expect(logSpy.mock.calls.flat().join('\\n')).toContain('f1 FACT project runner deploys');
    });

    it('searches by text', async () => {
      mockResolveContext.mockResolvedValueOnce({ ...CTX, projectSlug: 'alpha' });
      mockGetMemory.mockResolvedValue({ ret: 0, data: page });
      await program.parseAsync(['node', 'koda', 'memory', 'search', 'deployed runner', '--project', 'alpha']);
      expect(mockGetMemory).toHaveBeenCalledWith({ path: { slug: 'alpha' }, query: { text: 'deployed runner' } });
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('reaches a later result page with --page', async () => {
      mockResolveContext.mockResolvedValueOnce({ ...CTX, projectSlug: 'alpha' });
      mockGetMemory.mockResolvedValue({ ret: 0, data: { ...page, current: 2 } });
      await program.parseAsync([
        'node', 'koda', 'memory', 'search', 'deployed runner', '--project', 'alpha', '--page', '2',
      ]);
      expect(mockGetMemory).toHaveBeenCalledWith({
        path: { slug: 'alpha' },
        query: { text: 'deployed runner', current: 2 },
      });
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('names the next page when a search page has one', async () => {
      mockGetMemory.mockResolvedValue({ ret: 0, data: { ...page, current: 2, hasNext: true } });
      await program.parseAsync(['node', 'koda', 'memory', 'search', 'deployed runner', '--page', '2']);
      expect(logSpy.mock.calls.flat().join('\n')).toContain('Next: --page 3');
    });

    it('does not name a next page when the search result is the last page', async () => {
      mockGetMemory.mockResolvedValue({ ret: 0, data: page });
      await program.parseAsync(['node', 'koda', 'memory', 'search', 'deployed runner']);
      expect(logSpy.mock.calls.flat().join('\n')).not.toContain('Next: --page');
    });

    it('rejects an invalid search page before context resolution', async () => {
      await program.parseAsync(['node', 'koda', 'memory', 'search', 'deployed runner', '--page', '0']);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Invalid --page value: 0'));
      expect(mockGetMemory).not.toHaveBeenCalled();
      expect(mockResolveContext).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(3);
    });

    it('rejects invalid page before context resolution', async () => {
      await program.parseAsync(['node', 'koda', 'memory', 'list', '--page', '0']);
      expect(mockGetMemory).not.toHaveBeenCalled();
      expect(mockResolveContext).not.toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(3);
    });

    it('prints list HTTP 500 errors to stderr and exits 1', async () => {
      mockGetMemory.mockRejectedValue(Object.assign(new Error('server failed'), { statusCode: 500 }));
      await program.parseAsync(['node', 'koda', 'memory', 'list']);
      expect(errorSpy).toHaveBeenCalledWith('✗ server failed');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });

    it('prints search network errors to stderr and exits 1', async () => {
      mockGetMemory.mockRejectedValue(new Error('network unavailable'));
      await program.parseAsync(['node', 'koda', 'memory', 'search', 'deployed runner']);
      expect(errorSpy).toHaveBeenCalledWith('✗ network unavailable');
      expect(exitSpy).toHaveBeenCalledWith(1);
    });
  });
});
