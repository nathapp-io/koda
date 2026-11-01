import { KODA_DISPATCH_JOB, kodaToolDescriptorsFor } from './koda-tool-descriptors';
import { MCP_DESCRIPTIONS, mcpToolDescriptors } from './mcp/mcp-tool-catalog';

const byName = (name: string) => mcpToolDescriptors().find((descriptor) => descriptor.name === name);
const WORKSPACE_SENTENCE = 'In a workspace thread, name the project with `project` (a slug koda_my_projects lists).';
const MCP_PROJECT_SENTENCE = 'Name the project with `project` (a slug koda_my_projects lists).';

describe('US-001: PR dispatch descriptors', () => {
  it('AC-1: advertises RUN, PLAN, REVIEW and FIX', () => {
    expect((KODA_DISPATCH_JOB.inputSchema.properties as Record<string, { enum?: string[] }>).command.enum)
      .toEqual(['RUN', 'PLAN', 'REVIEW', 'FIX']);
  });

  it('AC-2: bounds prNumber to a positive 32-bit integer', () => {
    expect((KODA_DISPATCH_JOB.inputSchema.properties as Record<string, unknown>).prNumber)
      .toEqual({ type: 'integer', minimum: 1, maximum: 2147483647 });
  });

  it('AC-3: does not require feature for PR commands', () => {
    expect(KODA_DISPATCH_JOB.inputSchema.required).toEqual(['repo', 'command', 'maxCostUsd']);
  });

  it('AC-4, AC-5, AC-8: assistant description explains PR commands, approval and workspace limit', () => {
    const description = KODA_DISPATCH_JOB.description;
    expect(description).toContain('REVIEW');
    expect(description).toContain('FIX');
    expect(description).toContain('prNumber');
    expect(description).toContain('The job is started only after the user approves it: this call proposes it and the user decides it, so tell the user it is waiting for their approval and do not call this tool again for the same job.');
    const workspaceDescription = kodaToolDescriptorsFor('WORKSPACE').find((descriptor) => descriptor.name === 'koda_dispatch_job')?.description ?? '';
    expect(workspaceDescription.length).toBeLessThanOrEqual(2000);
    expect(workspaceDescription.endsWith(WORKSPACE_SENTENCE)).toBe(true);
  });

  it('AC-6, AC-7, AC-9: MCP description names PR commands, executes immediately and ends with project sentence', () => {
    const description = byName('koda_dispatch_job')?.description ?? '';
    expect(description).toContain('REVIEW');
    expect(description).toContain('FIX');
    expect(description).toContain('prNumber');
    expect(description).toContain('The call runs at once as the calling agent');
    expect(description.endsWith(MCP_PROJECT_SENTENCE)).toBe(true);
    expect(MCP_DESCRIPTIONS.koda_dispatch_job).toContain('REVIEW');
  });
});
