import { KODA_TOOL_LIMITS } from '@nathapp/fleet-protocol';
import {
  ACTION_TOOL_DESCRIPTORS, FLEET_TOOL_DESCRIPTORS, FLEET_WRITE_TOOL_DESCRIPTORS, KODA_ADD_COMMENT, KODA_ADD_MEMORY,
  KODA_CANCEL_JOB, KODA_CREATE_TICKETS, KODA_DISPATCH_JOB, KODA_GET_ACTION, KODA_GET_TICKET, KODA_LINK_TICKETS,
  KODA_MY_PROJECTS, KODA_RECORD_DECISION, KODA_REQUEUE_JOB, KODA_SEARCH_TICKETS, KODA_TOOL_DESCRIPTORS,
  KODA_UPDATE_TICKET, KNOWLEDGE_TOOL_DESCRIPTORS, TICKET_TOOL_DESCRIPTORS, WRITE_TOOL_DESCRIPTORS,
  kodaToolDescriptorsFor,
} from './koda-tool-descriptors';

/**
 * US-001 (1d2-D2): the per-kind koda tool catalog. REPO and PROJECT answer `KODA_TOOL_DESCRIPTORS` unchanged;
 * WORKSPACE puts `koda_my_projects` first and rewrites every catalog descriptor with the required `project`
 * argument. The catalog's own descriptors are never mutated.
 */
const WORKSPACE_SENTENCE = 'In a workspace thread, name the project with `project` (a slug koda_my_projects lists).';
const SLUG_PATTERN = '^[a-z0-9]+(-[a-z0-9]+)*$';
/** The `owner/name` rule (1c-c-D12) and the ticket ref rule (1b-D5) the fleet write schemas spell out. */
const REPO_PATTERN = '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$';
const TICKET_REF_PATTERN = '^[A-Z][A-Z0-9]*-[1-9][0-9]*$';
/** The runner refuses the whole tool list when one description is longer (`apps/runner/src/supervisor/assign-parser.ts`). */
const KODA_TOOL_DESCRIPTION_MAX_CHARS = 2_000;

type Schema = { type?: unknown; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: unknown };

const schemaOf = (name: string, kind: 'WORKSPACE' | 'REPO' = 'WORKSPACE'): Schema => {
  const descriptor = kodaToolDescriptorsFor(kind).find((d) => d.name === name);
  expect(descriptor).toBeDefined();
  return descriptor?.inputSchema as Schema;
};

/** One named property of a descriptor's schema, so a bound can be asserted without casting in every test. */
const propertyOf = (descriptor: { inputSchema: Record<string, unknown> }, name: string): Record<string, unknown> => {
  const schema = descriptor.inputSchema as Schema;
  return (schema.properties?.[name] ?? {}) as Record<string, unknown>;
};

/** The `items` schema of one array property, so an item's own bound can be asserted. */
const itemsOf = (descriptor: { inputSchema: Record<string, unknown> }, name: string): Schema =>
  (propertyOf(descriptor, name).items ?? {}) as Schema;

/** The `items.properties` of one array property. */
const itemPropertiesOf = (descriptor: { inputSchema: Record<string, unknown> }, name: string): Record<string, unknown> =>
  (itemsOf(descriptor, name).properties ?? {}) as Record<string, unknown>;

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

describe('US-003 (2a-D15): the action group is appended, never woven in', () => {
  it('AC-15: the action group directly precedes the write group', () => {
    const descriptors = kodaToolDescriptorsFor('REPO');
    const writeGroup = WRITE_TOOL_DESCRIPTORS.length + FLEET_WRITE_TOOL_DESCRIPTORS.length;
    const beforeWrite = descriptors.slice(-(writeGroup + 2), -writeGroup);
    expect(beforeWrite.map((descriptor) => descriptor.name)).toEqual(['koda_get_action', 'koda_add_comment']);
    expect(beforeWrite[0]).toBe(KODA_GET_ACTION);
    expect(beforeWrite[1]).toBe(KODA_ADD_COMMENT);
  });

  it.each(['REPO', 'PROJECT'] as const)('AC-22: %s keeps the three existing groups, in their existing order', (kind) => {
    const trailing = ACTION_TOOL_DESCRIPTORS.length + WRITE_TOOL_DESCRIPTORS.length + FLEET_WRITE_TOOL_DESCRIPTORS.length;
    expect(kodaToolDescriptorsFor(kind).slice(0, -trailing)).toEqual([
      ...TICKET_TOOL_DESCRIPTORS, ...FLEET_TOOL_DESCRIPTORS, ...KNOWLEDGE_TOOL_DESCRIPTORS,
    ]);
  });

  it('AC-22: the pre-action prefix is the catalog\'s own descriptors, none replaced or rewritten', () => {
    const descriptors = kodaToolDescriptorsFor('REPO');
    for (const [index, original] of [...TICKET_TOOL_DESCRIPTORS, ...FLEET_TOOL_DESCRIPTORS, ...KNOWLEDGE_TOOL_DESCRIPTORS].entries()) {
      expect(descriptors[index]).toBe(original);
    }
    expect(KODA_TOOL_DESCRIPTORS).toEqual([
      ...TICKET_TOOL_DESCRIPTORS, ...FLEET_TOOL_DESCRIPTORS, ...KNOWLEDGE_TOOL_DESCRIPTORS, ...ACTION_TOOL_DESCRIPTORS,
      ...WRITE_TOOL_DESCRIPTORS, ...FLEET_WRITE_TOOL_DESCRIPTORS,
    ]);
  });

  it('gives REPO and PROJECT 22 descriptors and WORKSPACE 23, all under the runner limit', () => {
    expect(kodaToolDescriptorsFor('REPO')).toHaveLength(22);
    expect(kodaToolDescriptorsFor('PROJECT')).toHaveLength(22);
    expect(kodaToolDescriptorsFor('WORKSPACE')).toHaveLength(23);
    expect(kodaToolDescriptorsFor('WORKSPACE').at(-1)?.name).toBe('koda_cancel_job');
    for (const kind of ['REPO', 'PROJECT', 'WORKSPACE'] as const) {
      expect(kodaToolDescriptorsFor(kind).length).toBeLessThan(KODA_TOOL_LIMITS.maxTools);
    }
  });

  it('describes koda_add_comment as a comment the user has to approve first', () => {
    expect(KODA_ADD_COMMENT.description).toContain('only added after the user approves it');
    expect(KODA_ADD_COMMENT.inputSchema).toMatchObject({ required: ['ref', 'body'] });
    expect(KODA_GET_ACTION.inputSchema).toMatchObject({ required: ['id'] });
  });
});

describe('US-002 (2b1-D3): the five write descriptors form the last group', () => {
  it('AC-1: WRITE_TOOL_DESCRIPTORS names the five write tools in their fixed order', () => {
    expect(WRITE_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)).toEqual([
      'koda_create_tickets', 'koda_update_ticket', 'koda_link_tickets', 'koda_add_memory', 'koda_record_decision',
    ]);
    expect(WRITE_TOOL_DESCRIPTORS).toEqual([
      KODA_CREATE_TICKETS, KODA_UPDATE_TICKET, KODA_LINK_TICKETS, KODA_ADD_MEMORY, KODA_RECORD_DECISION,
    ]);
  });

  it('AC-2: the WRITE_TOOL_DESCRIPTORS entries directly precede the FLEET_WRITE_TOOL_DESCRIPTORS entries', () => {
    const descriptors = kodaToolDescriptorsFor('REPO');
    const end = FLEET_WRITE_TOOL_DESCRIPTORS.length;
    const before = descriptors.slice(-(end + WRITE_TOOL_DESCRIPTORS.length), -end);
    expect(before).toEqual([...WRITE_TOOL_DESCRIPTORS]);
    for (const [index, original] of WRITE_TOOL_DESCRIPTORS.entries()) expect(before[index]).toBe(original);
  });

  it('AC-3: the two entries before them are koda_get_action and koda_add_comment', () => {
    const descriptors = kodaToolDescriptorsFor('REPO');
    const end = WRITE_TOOL_DESCRIPTORS.length + FLEET_WRITE_TOOL_DESCRIPTORS.length;
    const before = descriptors.slice(-(end + 2), -end);
    expect(before.map((descriptor) => descriptor.name)).toEqual(['koda_get_action', 'koda_add_comment']);
  });

  it('AC-4: REPO answers 22 descriptors', () => {
    expect(kodaToolDescriptorsFor('REPO')).toHaveLength(22);
  });

  it('AC-5: WORKSPACE answers 23 descriptors', () => {
    expect(kodaToolDescriptorsFor('WORKSPACE')).toHaveLength(23);
  });

  it('AC-6: every write description says the change happens only after the user approves', () => {
    for (const descriptor of WRITE_TOOL_DESCRIPTORS) {
      expect(descriptor.description).toContain('only after the user approves');
      // The pilot tool's second half (2a-D13): the model is told not to repeat the call.
      expect(descriptor.description).toContain('do not call this tool again');
    }
  });

  it('AC-7: every WORKSPACE description stays within the runner description cap', () => {
    for (const descriptor of kodaToolDescriptorsFor('WORKSPACE')) {
      expect(descriptor.description.length).toBeLessThanOrEqual(KODA_TOOL_DESCRIPTION_MAX_CHARS);
    }
    // The case the cap exists for: the workspace sentence is appended to every catalog entry (not koda_my_projects).
    for (const descriptor of kodaToolDescriptorsFor('WORKSPACE').slice(1)) {
      expect(descriptor.description).toContain(WORKSPACE_SENTENCE);
    }
  });

  it('names every write tool as the runner expects and keeps the catalog under maxTools', () => {
    for (const descriptor of WRITE_TOOL_DESCRIPTORS) expect(descriptor.name).toMatch(KODA_TOOL_LIMITS.nameRe);
    expect(kodaToolDescriptorsFor('WORKSPACE').length).toBeLessThanOrEqual(KODA_TOOL_LIMITS.maxTools);
  });

  it('gives every write tool a closed schema that requires its own input', () => {
    expect(KODA_CREATE_TICKETS.inputSchema).toMatchObject({ additionalProperties: false, required: ['tickets'] });
    expect(KODA_UPDATE_TICKET.inputSchema).toMatchObject({ additionalProperties: false, required: ['ref'] });
    expect(KODA_LINK_TICKETS.inputSchema).toMatchObject({ additionalProperties: false, required: ['links'] });
    expect(KODA_ADD_MEMORY.inputSchema).toMatchObject({ additionalProperties: false, required: ['kind', 'subject', 'predicate'] });
    expect(KODA_RECORD_DECISION.inputSchema).toMatchObject({ additionalProperties: false, required: ['topic', 'decision'] });
  });

  it('keeps the project injection and the catalog immutability for the write group', () => {
    const workspace = kodaToolDescriptorsFor('WORKSPACE');
    for (const original of WRITE_TOOL_DESCRIPTORS) {
      // The WORKSPACE rewrite requires project first and appends the sentence to a fresh descriptor…
      const rewritten = workspace.find((d) => d.name === original.name) as { inputSchema: Schema; description: string };
      expect(rewritten.inputSchema.required).toEqual(['project', ...((original.inputSchema as Schema).required ?? [])]);
      expect(rewritten.description).toBe(`${original.description} ${WORKSPACE_SENTENCE}`);
      expect(rewritten).not.toBe(original);
      // …and leaves the catalog's own entry as it was.
      expect(propertyOf(original, 'project')).toEqual({});
      expect((original.inputSchema as Schema).required ?? []).not.toContain('project');
    }
  });
});

describe('US-002 (2b1-D5): the write descriptors carry the parser bounds', () => {
  it('AC-8: koda_create_tickets takes a batch of 1 to 20 tickets', () => {
    expect(propertyOf(KODA_CREATE_TICKETS, 'tickets')).toMatchObject({ type: 'array', minItems: 1, maxItems: 20 });
  });

  it('AC-9: koda_link_tickets takes a batch of 1 to 20 links', () => {
    expect(propertyOf(KODA_LINK_TICKETS, 'links')).toMatchObject({ type: 'array', minItems: 1, maxItems: 20 });
  });

  it('AC-10: koda_update_ticket may set status to IN_PROGRESS only', () => {
    expect(propertyOf(KODA_UPDATE_TICKET, 'status').enum).toEqual(['IN_PROGRESS']);
    expect(KODA_UPDATE_TICKET.inputSchema).toMatchObject({ required: ['ref'] });
  });

  it('AC-11: koda_add_memory takes the four non-decision kinds, in order', () => {
    expect(propertyOf(KODA_ADD_MEMORY, 'kind').enum).toEqual([
      'FACT', 'PREFERENCE', 'CONSTRAINT', 'INCIDENT_PATTERN',
    ]);
  });

  it('bounds each item of the two batch tools', () => {
    const ticket = itemsOf(KODA_CREATE_TICKETS, 'tickets');
    expect(ticket).toMatchObject({ type: 'object', additionalProperties: false, required: ['type', 'title'] });
    expect(itemPropertiesOf(KODA_CREATE_TICKETS, 'tickets')).toMatchObject({
      type: { enum: ['BUG', 'ENHANCEMENT', 'TASK', 'QUESTION'] },
      title: { minLength: 1, maxLength: 200 },
      description: { maxLength: 4000 },
      priority: { enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
    });

    const link = itemsOf(KODA_LINK_TICKETS, 'links');
    expect(link).toMatchObject({ type: 'object', additionalProperties: false, required: ['ref', 'url'] });
    expect(itemPropertiesOf(KODA_LINK_TICKETS, 'links')).toMatchObject({
      ref: { pattern: '^[A-Z][A-Z0-9]*-[1-9][0-9]*$' },
      url: { maxLength: 2048 },
      linkType: { enum: ['url', 'pr', 'commit', 'branch'] },
    });
  });

  it('bounds the scalar fields of koda_update_ticket, koda_add_memory and koda_record_decision', () => {
    expect(propertyOf(KODA_UPDATE_TICKET, 'ref')).toMatchObject({ pattern: '^[A-Z][A-Z0-9]*-[1-9][0-9]*$' });
    expect(propertyOf(KODA_UPDATE_TICKET, 'title')).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(propertyOf(KODA_UPDATE_TICKET, 'description')).toMatchObject({ maxLength: 4000 });
    expect(propertyOf(KODA_UPDATE_TICKET, 'priority').enum).toEqual(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);

    expect(propertyOf(KODA_ADD_MEMORY, 'subject')).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(propertyOf(KODA_ADD_MEMORY, 'predicate')).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(propertyOf(KODA_ADD_MEMORY, 'object')).toMatchObject({ maxLength: 4000 });

    expect(propertyOf(KODA_RECORD_DECISION, 'topic')).toMatchObject({ minLength: 1, maxLength: 200 });
    expect(propertyOf(KODA_RECORD_DECISION, 'decision')).toMatchObject({ minLength: 1, maxLength: 4000 });
    expect(propertyOf(KODA_RECORD_DECISION, 'rationale')).toMatchObject({ maxLength: 4000 });
  });

  it('never offers DECISION as a memory kind to write (2b-R5 ruling, 2b1-D5)', () => {
    expect(propertyOf(KODA_ADD_MEMORY, 'kind').enum).not.toContain('DECISION');
  });
});

describe('US-001 (2b2-D1, 2b2-D3): the three fleet write descriptors are appended last', () => {
  it('AC-1: FLEET_WRITE_TOOL_DESCRIPTORS names the three fleet write tools in their fixed order', () => {
    expect(FLEET_WRITE_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name)).toEqual([
      'koda_dispatch_job', 'koda_requeue_job', 'koda_cancel_job',
    ]);
    expect(FLEET_WRITE_TOOL_DESCRIPTORS).toEqual([KODA_DISPATCH_JOB, KODA_REQUEUE_JOB, KODA_CANCEL_JOB]);
  });

  it.each(['REPO', 'PROJECT'] as const)('AC-2: %s ends with the FLEET_WRITE_TOOL_DESCRIPTORS entries, in order', (kind) => {
    const tail = kodaToolDescriptorsFor(kind).slice(-FLEET_WRITE_TOOL_DESCRIPTORS.length);
    expect(tail).toEqual([...FLEET_WRITE_TOOL_DESCRIPTORS]);
    for (const [index, original] of FLEET_WRITE_TOOL_DESCRIPTORS.entries()) expect(tail[index]).toBe(original);
  });

  it('AC-3: the five entries before them are the WRITE_TOOL_DESCRIPTORS entries, in order', () => {
    const end = FLEET_WRITE_TOOL_DESCRIPTORS.length;
    const before = kodaToolDescriptorsFor('REPO').slice(-(end + WRITE_TOOL_DESCRIPTORS.length), -end);
    expect(before.map((descriptor) => descriptor.name)).toEqual(
      WRITE_TOOL_DESCRIPTORS.map((descriptor) => descriptor.name),
    );
    for (const [index, original] of WRITE_TOOL_DESCRIPTORS.entries()) expect(before[index]).toBe(original);
  });

  it('AC-4: REPO answers 22 descriptors', () => {
    expect(kodaToolDescriptorsFor('REPO')).toHaveLength(22);
  });

  it('AC-5: WORKSPACE answers 23 descriptors', () => {
    expect(kodaToolDescriptorsFor('WORKSPACE')).toHaveLength(23);
  });

  it('AC-6: every fleet write description says the job acts only after the user approves', () => {
    for (const descriptor of FLEET_WRITE_TOOL_DESCRIPTORS) {
      expect(descriptor.description).toContain('only after the user approves');
    }
  });

  it('AC-7: every fleet write description tells the agent not to call the tool again', () => {
    for (const descriptor of FLEET_WRITE_TOOL_DESCRIPTORS) {
      expect(descriptor.description).toContain('do not call this tool again');
    }
  });

  it('AC-8: koda_dispatch_job requires repo, command, feature and maxCostUsd', () => {
    expect(KODA_DISPATCH_JOB.inputSchema).toMatchObject({ additionalProperties: false });
    expect((KODA_DISPATCH_JOB.inputSchema as Schema).required).toEqual(['repo', 'command', 'feature', 'maxCostUsd']);
  });

  it('AC-9: koda_dispatch_job takes command RUN or PLAN', () => {
    expect(propertyOf(KODA_DISPATCH_JOB, 'command').enum).toEqual(['RUN', 'PLAN']);
  });

  it('AC-10: koda_dispatch_job costs at least 0.0001', () => {
    expect(propertyOf(KODA_DISPATCH_JOB, 'maxCostUsd').minimum).toBe(0.0001);
  });

  it('AC-11: koda_dispatch_job costs at most 10000', () => {
    expect(propertyOf(KODA_DISPATCH_JOB, 'maxCostUsd').maximum).toBe(10000);
  });

  it('AC-12: koda_requeue_job requires jobId', () => {
    expect(KODA_REQUEUE_JOB.inputSchema).toMatchObject({ additionalProperties: false });
    expect((KODA_REQUEUE_JOB.inputSchema as Schema).required).toEqual(['jobId']);
  });

  it('AC-13: koda_cancel_job requires jobId', () => {
    expect(KODA_CANCEL_JOB.inputSchema).toMatchObject({ additionalProperties: false });
    expect((KODA_CANCEL_JOB.inputSchema as Schema).required).toEqual(['jobId']);
  });

  it('bounds the rest of the dispatch input as its parser will (2b2-D3)', () => {
    expect(propertyOf(KODA_DISPATCH_JOB, 'repo')).toMatchObject({ type: 'string', pattern: REPO_PATTERN });
    expect(propertyOf(KODA_DISPATCH_JOB, 'command')).toMatchObject({ type: 'string' });
    expect(propertyOf(KODA_DISPATCH_JOB, 'feature')).toMatchObject({ type: 'string', minLength: 1, maxLength: 128 });
    expect(propertyOf(KODA_DISPATCH_JOB, 'maxCostUsd')).toMatchObject({ type: 'number' });
    expect(propertyOf(KODA_DISPATCH_JOB, 'ref')).toMatchObject({ type: 'string', minLength: 1, maxLength: 255 });
    expect(propertyOf(KODA_DISPATCH_JOB, 'planFrom')).toMatchObject({ type: 'string', minLength: 1, maxLength: 512 });
    expect(propertyOf(KODA_DISPATCH_JOB, 'profiles')).toMatchObject({ type: 'array', maxItems: 8 });
    expect(itemsOf(KODA_DISPATCH_JOB, 'profiles')).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 });
    expect(propertyOf(KODA_DISPATCH_JOB, 'bashMode')).toMatchObject({ type: 'string', enum: ['raw', 'gated', 'escalate'] });
    expect(propertyOf(KODA_DISPATCH_JOB, 'ticketRefs')).toMatchObject({ type: 'array', minItems: 1, maxItems: 20 });
    expect(itemsOf(KODA_DISPATCH_JOB, 'ticketRefs')).toMatchObject({ type: 'string', pattern: TICKET_REF_PATTERN });
    for (const descriptor of [KODA_REQUEUE_JOB, KODA_CANCEL_JOB]) {
      expect(propertyOf(descriptor, 'jobId')).toMatchObject({ type: 'string', minLength: 1, maxLength: 64 });
    }
  });

  it('keeps every fleet write description inside the runner cap once the workspace sentence is appended', () => {
    for (const descriptor of FLEET_WRITE_TOOL_DESCRIPTORS) {
      expect(descriptor.description.length).toBeLessThanOrEqual(
        KODA_TOOL_DESCRIPTION_MAX_CHARS - WORKSPACE_SENTENCE.length - 1,
      );
    }
    const workspace = kodaToolDescriptorsFor('WORKSPACE');
    for (const descriptor of FLEET_WRITE_TOOL_DESCRIPTORS) {
      expect(workspace.find((d) => d.name === descriptor.name)?.description).toBe(
        `${descriptor.description} ${WORKSPACE_SENTENCE}`,
      );
    }
  });

  it('names every fleet write tool as the runner expects', () => {
    for (const descriptor of FLEET_WRITE_TOOL_DESCRIPTORS) expect(descriptor.name).toMatch(KODA_TOOL_LIMITS.nameRe);
  });
});

