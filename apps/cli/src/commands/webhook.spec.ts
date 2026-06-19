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
  webhookControllerRegister: jest.fn(),
  webhookControllerList: jest.fn(),
  webhookControllerRemove: jest.fn(),
  OpenAPI: { BASE: '', TOKEN: '' },
}));
jest.mock('../generated/core/OpenAPI', () => ({ OpenAPI: { BASE: '', TOKEN: '' } }));

jest.mock('../config', () => ({
  resolveContext: jest.fn(),
}));

import { Command } from 'commander';
import { webhookCommand } from './webhook';
import {
  webhookControllerRegister,
  webhookControllerList,
  webhookControllerRemove,
} from '../generated';
import { resolveContext } from '../config';

const mockResolveContext = resolveContext as jest.Mock;
const mockRegister = webhookControllerRegister as jest.Mock;
const mockList = webhookControllerList as jest.Mock;
const mockRemove = webhookControllerRemove as jest.Mock;

const CTX = { apiKey: 'sk-test', apiUrl: 'http://localhost:3100/api', projectSlug: 'my-proj' };

describe('webhookCommand', () => {
  let program: Command;
  let exitSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    program = new Command();
    program.exitOverride();
    webhookCommand(program);
    mockResolveContext.mockResolvedValue(CTX);
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('create', () => {
    it('registers a webhook and prints a table', async () => {
      const webhook = { id: 'wh-1', url: 'https://example.com/hook', events: ['STATUS_CHANGE'] };
      mockRegister.mockResolvedValue({ ret: 0, data: webhook });

      await program.parseAsync(['node', 'koda', 'webhook', 'create', '--url', 'https://example.com/hook']);

      expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({ slug: 'my-proj', requestBody: expect.objectContaining({ url: 'https://example.com/hook' }) }));
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json flag is set', async () => {
      const webhook = { id: 'wh-1', url: 'https://example.com/hook', events: ['STATUS_CHANGE'] };
      mockRegister.mockResolvedValue({ ret: 0, data: webhook });

      await program.parseAsync(['node', 'koda', 'webhook', 'create', '--url', 'https://example.com/hook', '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(webhook, null, 2));
    });

    it('passes custom events and secret', async () => {
      mockRegister.mockResolvedValue({ ret: 0, data: { id: 'wh-2', url: 'https://example.com', events: ['COMMENT'] } });

      await program.parseAsync(['node', 'koda', 'webhook', 'create', '--url', 'https://example.com', '--events', 'COMMENT,CREATED', '--secret', 'mysecret']);

      expect(mockRegister).toHaveBeenCalledWith(expect.objectContaining({
        requestBody: expect.objectContaining({ events: ['COMMENT', 'CREATED'], secret: 'mysecret' }),
      }));
    });
  });

  describe('list', () => {
    it('lists webhooks and prints a table', async () => {
      const items = [{ id: 'wh-1', url: 'https://example.com', events: ['STATUS_CHANGE'] }];
      mockList.mockResolvedValue({ ret: 0, data: items });

      await program.parseAsync(['node', 'koda', 'webhook', 'list']);

      expect(mockList).toHaveBeenCalledWith({ slug: 'my-proj' });
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json flag is set', async () => {
      const items = [{ id: 'wh-1', url: 'https://example.com', events: [] }];
      mockList.mockResolvedValue({ ret: 0, data: items });

      await program.parseAsync(['node', 'koda', 'webhook', 'list', '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify(items, null, 2));
    });
  });

  describe('delete', () => {
    it('deletes a webhook by ID', async () => {
      mockRemove.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'koda', 'webhook', 'delete', '--id', 'wh-1']);

      expect(mockRemove).toHaveBeenCalledWith({ id: 'wh-1' });
      expect(exitSpy).toHaveBeenCalledWith(0);
    });

    it('outputs JSON when --json flag is set', async () => {
      mockRemove.mockResolvedValue(undefined);

      await program.parseAsync(['node', 'koda', 'webhook', 'delete', '--id', 'wh-1', '--json']);

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ deleted: true, id: 'wh-1' }));
    });
  });
});
