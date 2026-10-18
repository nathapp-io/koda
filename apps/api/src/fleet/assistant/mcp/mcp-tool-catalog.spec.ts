import { KODA_TOOL_LIMITS } from '@nathapp/fleet-protocol';
import { KODA_MY_PROJECTS, KODA_SEARCH_TICKETS, KODA_TOOL_DESCRIPTORS, kodaToolDescriptorsFor } from '../koda-tool-descriptors';
import { MCP_DESCRIPTIONS, mcpToolDescriptors, toMcpToolResult } from './mcp-tool-catalog';

/**
 * US-006 (3-D16, 3-D17): the MCP projection of the koda tool catalog. The descriptors are the WORKSPACE ones —
 * koda_my_projects and every project tool with a required `project` — with the thread wording of the write tools
 * replaced, because an MCP write runs at once instead of waiting for a user's approval.
 */
const MCP_SENTENCE = 'Name the project with `project` (a slug koda_my_projects lists).';
const WORKSPACE_SENTENCE = 'In a workspace thread, name the project with `project` (a slug koda_my_projects lists).';
/** The runner refuses a whole tool list when one description is longer (the same cap the ASSIGN catalog keeps). */
const MCP_DESCRIPTION_MAX_CHARS = 2_000;
/** The nine write tools (3-D16): every one of them is proposed in a thread and executed at once over MCP. */
const WRITE_TOOLS = [
  'koda_add_comment', 'koda_create_tickets', 'koda_update_ticket', 'koda_link_tickets', 'koda_add_memory',
  'koda_record_decision', 'koda_dispatch_job', 'koda_requeue_job', 'koda_cancel_job',
] as const;
/** 3-D16: the one read tool whose thread wording is false over MCP, so it carries an MCP description too. */
const MCP_DESCRIPTION_TOOLS = ['koda_get_action', ...WRITE_TOOLS];

type Schema = { required?: string[]; properties?: Record<string, unknown> };

const mcp = () => mcpToolDescriptors();
const byName = (name: string) => mcp().find((descriptor) => descriptor.name === name);
/** Whether one tool's description comes from the fixed MCP map rather than the sentence rewrite. */
const hasMcpDescription = (name: string): boolean => Object.prototype.hasOwnProperty.call(MCP_DESCRIPTIONS, name);
const workspaceByName = (name: string) => kodaToolDescriptorsFor('WORKSPACE').find((d) => d.name === name);

describe('US-006 AC-1, AC-2: the MCP catalog is the WORKSPACE catalog, in its order', () => {
  it('AC-1: names every tool as kodaToolDescriptorsFor(WORKSPACE) names it', () => {
    const names = mcp().map((descriptor) => descriptor.name);
    expect(names).toEqual(kodaToolDescriptorsFor('WORKSPACE').map((descriptor) => descriptor.name));
    expect(names).toHaveLength(kodaToolDescriptorsFor('WORKSPACE').length);
  });

  it('AC-2: names koda_my_projects first', () => {
    expect(mcp()[0]?.name).toBe('koda_my_projects');
  });

  it('answers one descriptor per catalog tool plus koda_my_projects, in the catalog order', () => {
    expect(mcp().slice(1).map((descriptor) => descriptor.name)).toEqual(
      KODA_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name),
    );
  });
});

describe('US-006 AC-3, AC-4: the input schemas are the WORKSPACE ones, unchanged', () => {
  it('AC-3: every entry but koda_my_projects requires project first', () => {
    for (const descriptor of mcp()) {
      if (descriptor.name === 'koda_my_projects') continue;
      expect((descriptor.inputSchema as Schema).required?.[0]).toBe('project');
    }
  });

  it('AC-3: leaves koda_my_projects without a project argument', () => {
    const schema = byName('koda_my_projects')?.inputSchema as Schema;
    expect(schema.required ?? []).not.toContain('project');
    expect(schema.properties ?? {}).not.toHaveProperty('project');
  });

  it('AC-4: deep-equals the WORKSPACE inputSchema for every name, and only the description differs', () => {
    for (const descriptor of kodaToolDescriptorsFor('WORKSPACE')) {
      const projected = byName(descriptor.name);
      expect(projected).toBeDefined();
      expect(projected?.inputSchema).toEqual(descriptor.inputSchema);
      expect(projected?.name).toBe(descriptor.name);
      expect(Object.keys(projected as object).sort()).toEqual(['description', 'inputSchema', 'name']);
    }
  });
});

describe('US-006 AC-5: MCP_DESCRIPTIONS names koda_get_action and the nine write tools', () => {
  it('AC-5: keys exactly koda_get_action and the nine write tools', () => {
    expect(new Set(Object.keys(MCP_DESCRIPTIONS))).toEqual(new Set(MCP_DESCRIPTION_TOOLS));
    expect(Object.keys(MCP_DESCRIPTIONS)).toHaveLength(MCP_DESCRIPTION_TOOLS.length);
  });

  it('AC-5: gives every one of them a description naming the project and no thread wording', () => {
    for (const name of MCP_DESCRIPTION_TOOLS) {
      const description = MCP_DESCRIPTIONS[name];
      expect(typeof description).toBe('string');
      expect(description).toContain(MCP_SENTENCE);
      expect(description).not.toContain('In a workspace thread');
      expect(description).not.toContain('only after the user approves');
      expect(description).not.toContain('do not call this tool again');
    }
  });

  it('AC-5: names only tools of the catalog', () => {
    const names = new Set(KODA_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name));
    for (const name of Object.keys(MCP_DESCRIPTIONS)) expect(names).toContain(name);
  });
});

describe('US-006 AC-6, AC-7: over MCP a write runs at once, it is not proposed', () => {
  it('AC-6: no description keeps the approval wording', () => {
    for (const descriptor of mcp()) {
      expect(descriptor.description).not.toContain('only after the user approves');
      expect(descriptor.description).not.toContain('do not call this tool again');
    }
  });

  it.each(WRITE_TOOLS)('AC-7: %s says the call runs at once as the calling agent', (name) => {
    const description = byName(name)?.description ?? '';
    expect(description).toContain('runs at once as the calling agent');
    expect(description).toContain('the answer ends with the action id');
  });

  it('AC-7: koda_get_action is a read, so it carries no such sentence', () => {
    expect(byName('koda_get_action')?.description).not.toContain('runs at once as the calling agent');
  });
});

describe('US-006 AC-8: every MCP description names the project without the thread sentence', () => {
  it('AC-8: every entry but koda_my_projects names the project', () => {
    for (const descriptor of mcp()) {
      if (descriptor.name === 'koda_my_projects') continue;
      expect(descriptor.description).toContain(MCP_SENTENCE);
    }
  });

  it('AC-8: no entry keeps "In a workspace thread"', () => {
    for (const descriptor of mcp()) {
      expect(descriptor.description).not.toContain('In a workspace thread');
      expect(descriptor.description).not.toContain(WORKSPACE_SENTENCE);
    }
  });

  it('AC-8: rewrites the sentence once, leaving the rest of the description as the catalog spells it', () => {
    for (const descriptor of mcp()) {
      if (descriptor.name === 'koda_my_projects' || hasMcpDescription(descriptor.name)) continue;
      expect(descriptor.description).toBe(
        (workspaceByName(descriptor.name)?.description ?? '').replace(WORKSPACE_SENTENCE, MCP_SENTENCE),
      );
    }
  });
});

describe('US-006 AC-9: the read tools keep the catalog wording', () => {
  it('AC-9: koda_search_tickets starts with its catalog description', () => {
    const description = byName('koda_search_tickets')?.description ?? '';
    expect(description.startsWith(KODA_SEARCH_TICKETS.description)).toBe(true);
    expect(description).toBe(`${KODA_SEARCH_TICKETS.description} ${MCP_SENTENCE}`);
  });

  it('AC-9: every tool without an MCP description keeps its catalog text, then the MCP sentence', () => {
    for (const descriptor of KODA_TOOL_DESCRIPTORS) {
      if (hasMcpDescription(descriptor.name)) continue;
      expect(byName(descriptor.name)?.description).toBe(`${descriptor.description} ${MCP_SENTENCE}`);
    }
  });
});

describe('US-006 AC-10: the MCP catalog fits the tool-list caps', () => {
  it('AC-10: every description is at most 2000 characters', () => {
    for (const descriptor of mcp()) {
      expect(descriptor.description.length).toBeLessThanOrEqual(MCP_DESCRIPTION_MAX_CHARS);
    }
  });

  it('AC-10: stays inside the runner tool count and name rules', () => {
    expect(mcp().length).toBeLessThanOrEqual(KODA_TOOL_LIMITS.maxTools);
    for (const descriptor of mcp()) expect(descriptor.name).toMatch(KODA_TOOL_LIMITS.nameRe);
  });
});

describe('US-006 (3-D16): the projection never touches the catalog', () => {
  it('answers fresh descriptors and leaves the WORKSPACE projection as it is', () => {
    const workspace = kodaToolDescriptorsFor('WORKSPACE');
    const projected = mcp();
    expect(projected).not.toBe(workspace);
    for (const [index, descriptor] of projected.entries()) expect(descriptor).not.toBe(workspace[index]);
    for (const descriptor of workspace.slice(1)) {
      expect(descriptor.description).toContain(WORKSPACE_SENTENCE);
      expect(descriptor.description).not.toContain('Name the project with');
    }
    expect(KODA_MY_PROJECTS.description).not.toContain('Name the project with');
  });

  it('answers the same names and schemas on every call', () => {
    expect(mcp()).toEqual(mcp());
  });
});

describe('US-006 AC-11, AC-12 (3-D17): a ToolResult becomes MCP content', () => {
  it('AC-11: maps a successful result to one text content block', () => {
    expect(toMcpToolResult({ content: 'x', isError: false })).toEqual({
      content: [{ type: 'text', text: 'x' }],
      isError: false,
    });
  });

  it('AC-12: maps a failed result to one text content block with isError true', () => {
    const result = toMcpToolResult({ content: 'not_found', isError: true });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'not_found' }]);
  });

  it('keeps a multi-line answer in one block', () => {
    const text = 'comment c1 added to WEB-1 /web/tickets/WEB-1\naction a1';
    expect(toMcpToolResult({ content: text, isError: false })).toEqual({
      content: [{ type: 'text', text }],
      isError: false,
    });
  });
});
