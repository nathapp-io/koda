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
  adminControllerGetOutbox: jest.fn(),
  adminControllerRetryOutboxEvent: jest.fn(),
  sloDashboardControllerGetSloMetrics: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));
jest.mock('../generated/core/OpenAPI', () => ({ OpenAPI: { BASE: '', TOKEN: '' } }));

jest.mock('../config', () => ({
  resolveContext: jest.fn(),
}));

import { Command } from 'commander';
import { adminCommand } from './admin';
import {
  adminControllerGetOutbox,
  adminControllerRetryOutboxEvent,
  sloDashboardControllerGetSloMetrics,
} from '../generated';
import { resolveContext } from '../config';

const mockResolveContext = resolveContext as jest.Mock;
const mockGetOutbox = adminControllerGetOutbox as jest.Mock;
const mockRetryEvent = adminControllerRetryOutboxEvent as jest.Mock;
const mockGetSlos = sloDashboardControllerGetSloMetrics as jest.Mock;

const CTX = { apiKey: 'sk-test', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };

describe('adminCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    adminCommand(program);
    mockResolveContext.mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('outbox list', () => {
    it('lists outbox events and prints a table', async () => {
      const items = [{ id: 'ev-1', type: 'STATUS_CHANGE', status: 'pending', createdAt: '2026-01-01' }];
      mockGetOutbox.mockResolvedValue({ ret: 0, data: items });

      await program.parseAsync(['node', 'koda', 'admin', 'outbox', 'list']);

      expect(mockGetOutbox).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json is set', async () => {
      const items = [{ id: 'ev-1', type: 'STATUS_CHANGE', status: 'pending', createdAt: '2026-01-01' }];
      mockGetOutbox.mockResolvedValue({ ret: 0, data: items });

      await program.parseAsync(['node', 'koda', 'admin', 'outbox', 'list', '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(items, null, 2));
    });

    it('passes --status filter to API', async () => {
      mockGetOutbox.mockResolvedValue({ ret: 0, data: [] });

      await program.parseAsync(['node', 'koda', 'admin', 'outbox', 'list', '--status', 'failed']);

      expect(mockGetOutbox).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed' }));
    });
  });

  describe('outbox retry', () => {
    it('retries an outbox event by ID', async () => {
      mockRetryEvent.mockResolvedValue({ ret: 0, data: { id: 'ev-1', status: 'pending' } });

      await program.parseAsync(['node', 'koda', 'admin', 'outbox', 'retry', '--event-id', 'ev-1']);

      expect(mockRetryEvent).toHaveBeenCalledWith({ eventId: 'ev-1' });
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json is set', async () => {
      const result = { id: 'ev-1', status: 'pending' };
      mockRetryEvent.mockResolvedValue({ ret: 0, data: result });

      await program.parseAsync(['node', 'koda', 'admin', 'outbox', 'retry', '--event-id', 'ev-1', '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(result, null, 2));
    });
  });

  describe('slos', () => {
    it('fetches SLO metrics and prints a table', async () => {
      const data = { metrics: [{ name: 'p95_latency_ms', value: '120', target: '200', status: 'ok' }] };
      mockGetSlos.mockResolvedValue({ ret: 0, data });

      await program.parseAsync(['node', 'koda', 'admin', 'slos']);

      expect(mockGetSlos).toHaveBeenCalled();
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json is set', async () => {
      const data = { metrics: [] };
      mockGetSlos.mockResolvedValue({ ret: 0, data });

      await program.parseAsync(['node', 'koda', 'admin', 'slos', '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(data, null, 2));
    });

    it('passes from/to filters to API', async () => {
      mockGetSlos.mockResolvedValue({ ret: 0, data: {} });

      await program.parseAsync(['node', 'koda', 'admin', 'slos', '--from', '2026-01-01', '--to', '2026-06-01']);

      expect(mockGetSlos).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-01-01', to: '2026-06-01' }));
    });
  });
});
