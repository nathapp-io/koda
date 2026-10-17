import { KODA_TOOL_LIMITS } from '@nathapp/fleet-protocol';
import {
  KODA_GET_TICKET, KODA_MY_PROJECTS, KODA_SEARCH_TICKETS, KODA_TOOL_DESCRIPTORS, kodaToolDescriptorsFor,
} from './koda-tool-descriptors';

/**
 * US-001 (1d2-D2): the per-kind koda tool catalog. REPO and PROJECT answer `KODA_TOOL_DESCRIPTORS` unchanged;
 * WORKSPACE puts `koda_my_projects` first and rewrites every catalog descriptor with the required `project`
 * argument. The catalog's own descriptors are never mutated.
 */
const WORKSPACE_SENTENCE = 'In a workspace thread, name the project with `project` (a slug koda_my_projects lists).';
const SLUG_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$';

type Schema = { type?: unknown; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };

const schemaOf = (name: string, kind: 'WORKSPACE' | 'REPO' = 'WORKSPACE'): Schema => {
  const descriptor = kodaToolDescriptorsFor(kind).find((d) => d.name === name);
  expect(descriptor).toBeDefined();
  return descriptor?.inputSchema as Schema;
};

describe('US-001 AC-1, AC-2: REPO and PROJECT answer the catalog unchanged', () => {
  it.each(['REPO', 'PROJECT'] as const)('AC-%s: answers KODA_TOOL_DESCRIPTORS element by element, in order', (kind) => {
    expect(kodaToolDescriptorsFor(kind)).toEqual([...KODA_TOOL_DESCRIPTORS]);
  });

  it.each(['REPO', 'PROJECT'] as const)('%s: shares the catalog descriptors, none rewritten', (kind) => {
    const returned = kodaToolDescriptorsFor(kind);
    expect(returned).toHaveLength(KODA_TOOL_DESCRIPTORS.length);
    for (const [index, descriptor] of returned.entries()) expect(descriptor).toBe(KODA_TOOL_DESCRIPTORS[index]);
  });
});

describe('US-001 AC-3, AC-4: the WORKSPACE catalog leads with koda_my_projects', () => {
  it('AC-3: names koda_my_projects first', () => {
    expect(kodaToolDescriptorsFor('WORKSPACE')[0]?.name).toBe('koda_my_projects');
    expect(kodaToolDescriptorsFor('WORKSPACE')[0]).toBe(KODA_MY_PROJECTS);
  });

  it('AC-4: has exactly one descriptor more than the catalog, in the catalog order after the first', () => {
    const workspace = kodaToolDescriptorsFor('WORKSPACE');
    expect(workspace).toHaveLength(KODA_TOOL_DESCRIPTORS.length + 1);
    expect(workspace.slice(1).map((d) => d.name)).toEqual(KODA_TOOL_DESCRIPTORS.map((d) => d.name));
  });
});

describe('US-001 AC-5, AC-6: every catalog descriptor requires project first', () => {
  it('AC-5: lists project as the first required entry', () => {
    for (const descriptor of kodaToolDescriptorsFor('WORKSPACE').slice(1)) {
      expect(schemaOf(descriptor.name).required?.[0]).toBe('project');
      expect(schemaOf(descriptor.name).properties).toHaveProperty('project');
    }
  });

  it('AC-6: koda_get_ticket requires exactly project and ref', () => {
    expect(schemaOf('koda_get_ticket').required).toEqual(['project', 'ref']);
    expect(KODA_GET_TICKET.inputSchema).toMatchObject({ required: ['ref'] });
  });

  it('keeps the tool’s own required entries after project, in their own order', () => {
    const workspace = kodaToolDescriptorsFor('WORKSPACE');
    for (const original of KODA_TOOL_DESCRIPTORS) {
      const required = (original.inputSchema as Schema).required ?? [];
      const rewritten = workspace.find((d) => d.name === original.name) as { inputSchema: Schema };
      expect(rewritten.inputSchema.required).toEqual(['project', ...required]);
    }
  });
});

describe('US-001 AC-7, AC-8: the project argument and its sentence', () => {
  it('AC-7: koda_search_tickets describes project as a string matching the slug pattern', () => {
    const project = schemaOf('koda_search_tickets').properties?.project as { type?: unknown; pattern?: unknown };
    expect(project.type).toBe('string');
    expect(project.pattern).toBe(SLUG_PATTERN);
    expect(project).toMatchObject({ maxLength: 100 });
  });

  it('AC-8: koda_search_tickets ends its description with the workspace sentence', () => {
    const descriptor = kodaToolDescriptorsFor('WORKSPACE').find((d) => d.name === 'koda_search_tickets');
    expect(descriptor?.description.endsWith(WORKSPACE_SENTENCE)).toBe(true);
    expect(descriptor?.description).toBe(`${KODA_SEARCH_TICKETS.description} ${WORKSPACE_SENTENCE}`);
  });

  it('appends the sentence to every rewritten descriptor exactly once', () => {
    for (const descriptor of kodaToolDescriptorsFor('WORKSPACE').slice(1)) {
      expect(descriptor.description.endsWith(WORKSPACE_SENTENCE)).toBe(true);
      expect(descriptor.description.split(WORKSPACE_SENTENCE)).toHaveLength(2);
    }
  });
});

describe('US-001 AC-9: koda_my_projects takes no input', () => {
  it('AC-9: has an empty properties object and refuses additional properties', () => {
    const schema = KODA_MY_PROJECTS.inputSchema as Schema;
    expect(schema.properties).toEqual({});
    expect(schema.additionalProperties).toBe(false);
    expect(schema).toEqual({ type: 'object', properties: {}, additionalProperties: false });
  });

  it('takes no input in the WORKSPACE catalog either', () => {
    expect(kodaToolDescriptorsFor('WORKSPACE')[0]?.inputSchema).toEqual(
      { type: 'object', properties: {}, additionalProperties: false },
    );
  });
});

describe('US-001 AC-10: the catalog descriptors stay untouched', () => {
  it('AC-10: koda_search_tickets has no required key and no project property after the workspace call', () => {
    kodaToolDescriptorsFor('WORKSPACE');
    const schema = KODA_SEARCH_TICKETS.inputSchema as Schema;
    expect(schema).not.toHaveProperty('required');
    expect(schema.properties).not.toHaveProperty('project');
  });

  it('AC-10: every catalog descriptor is deep-equal to the WORKSPACE rewrite minus project', () => {
    for (const original of KODA_TOOL_DESCRIPTORS) {
      const schema = original.inputSchema as Schema;
      expect(schema.properties?.project).toBeUndefined();
      expect(schema.required ?? []).not.toContain('project');
    }
  });
});

describe('US-001 AC-11: the WORKSPACE catalog fits the runner limits', () => {
  it('AC-11: holds at most maxTools descriptors, each named as the runner expects', () => {
    const workspace = kodaToolDescriptorsFor('WORKSPACE');
    expect(workspace.length).toBeLessThanOrEqual(KODA_TOOL_LIMITS.maxTools);
    for (const descriptor of workspace) expect(descriptor.name).toMatch(KODA_TOOL_LIMITS.nameRe);
  });
});
