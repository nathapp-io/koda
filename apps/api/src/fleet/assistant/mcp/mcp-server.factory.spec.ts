import { Logger } from '@nestjs/common';
import type { AgentPrincipal } from '../../../auth/principal/koda-principal.types';
import { createKodaMcpServer, kodaMcpToolRegistrations } from './mcp-server.factory';
import { mcpToolDescriptors } from './mcp-tool-catalog';

const principal = { actorType: 'agent', id: 'agent-1', slug: 'claude' } as unknown as AgentPrincipal;

describe('kodaMcpToolRegistrations', () => {
  const executeFor = vi.fn();

  beforeEach(() => {
    executeFor.mockReset();
    executeFor.mockResolvedValue({ content: 'ok', isError: false });
  });

  it('AC-15: answers one registration per mcpToolDescriptors() entry, in order', () => {
    const registrations = kodaMcpToolRegistrations({ executeFor }, principal);

    expect(registrations.map((r) => r.name)).toEqual(mcpToolDescriptors().map((d) => d.name));
    expect(registrations.map((r) => r.description)).toEqual(mcpToolDescriptors().map((d) => d.description));
  });

  it('a handler calls executeFor as the agent with an mcp origin and answers the MCP tool result', async () => {
    const [first] = kodaMcpToolRegistrations({ executeFor }, principal);

    const answer = await first.handler({ project: 'web' });

    expect(executeFor).toHaveBeenCalledWith(
      { principal, origin: { kind: 'mcp' }, disabled: false },
      { name: first.name, input: { project: 'web' } },
    );
    expect(answer).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: false });
  });

  it('a handler whose executeFor throws logs the error and answers `error: <name> failed`', async () => {
    const logError = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    executeFor.mockRejectedValue(new Error('boom'));
    const [first] = kodaMcpToolRegistrations({ executeFor }, principal);

    const answer = await first.handler({});

    expect(answer).toEqual({ content: [{ type: 'text', text: `error: ${first.name} failed` }], isError: true });
    expect(logError).toHaveBeenCalled();
    logError.mockRestore();
  });
});

describe('createKodaMcpServer', () => {
  it('builds a server named koda that accepts every registration', () => {
    const registrations = kodaMcpToolRegistrations({ executeFor: vi.fn() }, principal);

    expect(() => createKodaMcpServer(registrations)).not.toThrow();
  });
});
