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
  OpenAPI: { BASE: '', TOKEN: '' },
}));
jest.mock('../generated/core/OpenAPI', () => ({ OpenAPI: { BASE: '', TOKEN: '' } }));

jest.mock('../config', () => ({
  resolveContext: jest.fn(),
}));

import { Command } from 'commander';
import { memoryCommand } from './memory';
import { timelineControllerGetTimeline } from '../generated';
import { resolveContext } from '../config';

const mockResolveContext = resolveContext as jest.Mock;
const mockGetTimeline = timelineControllerGetTimeline as jest.Mock;

const CTX = { apiKey: 'sk-test', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };

describe('memoryCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    memoryCommand(program);
    mockResolveContext.mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('timeline', () => {
    it('fetches timeline and prints a table', async () => {
      const items = [{ type: 'TICKET_CREATED', actorUserId: 'u-1', ticketId: 't-1', createdAt: '2026-01-01T00:00:00Z' }];
      mockGetTimeline.mockResolvedValue({ ret: 0, data: items });

      await program.parseAsync(['node', 'koda', 'memory', 'timeline']);

      expect(mockGetTimeline).toHaveBeenCalledWith(expect.objectContaining({ slug: 'my-proj' }));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json flag is set', async () => {
      const items = [{ type: 'COMMENT', actorUserId: 'u-2', ticketId: 't-2', createdAt: '2026-01-02T00:00:00Z' }];
      mockGetTimeline.mockResolvedValue({ ret: 0, data: items });

      await program.parseAsync(['node', 'koda', 'memory', 'timeline', '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(items, null, 2));
    });

    it('passes filter options to the API', async () => {
      mockGetTimeline.mockResolvedValue({ ret: 0, data: [] });

      await program.parseAsync([
        'node', 'koda', 'memory', 'timeline',
        '--actor-id', 'u-1',
        '--ticket-id', 't-1',
        '--from', '2026-01-01',
        '--to', '2026-06-01',
        '--limit', '10',
      ]);

      expect(mockGetTimeline).toHaveBeenCalledWith(expect.objectContaining({
        actorId: 'u-1',
        ticketId: 't-1',
        from: '2026-01-01',
        to: '2026-06-01',
        limit: '10',
      }));
    });

    it('handles empty result gracefully', async () => {
      mockGetTimeline.mockResolvedValue({ ret: 0, data: [] });

      await program.parseAsync(['node', 'koda', 'memory', 'timeline', '--json']);

      expect(logSpy).toHaveBeenCalledWith('[]');
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });
});
