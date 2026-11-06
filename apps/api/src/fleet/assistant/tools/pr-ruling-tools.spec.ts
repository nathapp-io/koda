import { createMock } from '@golevelup/ts-vitest';
import { NotFoundAppException, ValidationAppException } from '@nathapp/nestjs-common';
import { ConflictAppException } from '../../../common/exceptions/conflict-app.exception';
import { FleetPrRulingsService } from '../../rulings/fleet-pr-rulings.service';
import { AssistantToolRegistry } from '../assistant-tool.registry';
import { ToolActionError, ToolInputError, type ToolContext } from '../assistant-tool.types';
import { FLEET_WRITE_TOOL_DESCRIPTORS, KODA_TOOL_DESCRIPTORS, kodaToolDescriptorsFor } from '../koda-tool-descriptors';
import { mcpToolDescriptors } from '../mcp/mcp-tool-catalog';
import { PrRulingTools } from './pr-ruling-tools';

function setup() {
  const service = createMock<FleetPrRulingsService>();
  const registry = new AssistantToolRegistry();
  new PrRulingTools(registry, service).onModuleInit();
  const ctx = createMock<ToolContext>({ projectId: 'p1', projectSlug: 'web', actor: { actorType: 'agent', id: 'a1', name: 'ruler' }, data: (text) => `<data>${text}</data>` });
  const read = registry.get('koda_list_pr_rulings');
  const write = registry.get('koda_rule_pr_item');
  if (!read || !write || !write.preview) throw new Error('ruling tools not registered');
  return { service, ctx, read, write, preview: write.preview };
}
const input = { jobId: 'j1', itemId: 'D-1', text: 'confirm: test green' };
describe('PR ruling tools', () => {
  it('AC-1: lists one fenced line per ruling with item/disposition/state/actor', async () => {
    const s = setup();
    s.service.list.mockResolvedValue([{ itemId: 'D-1', disposition: 'confirmed', state: 'pending', actorType: 'AGENT', actorId: 'a1' }] as Awaited<ReturnType<FleetPrRulingsService['list']>>);
    expect(s.read.key).toBe('fleet.job.read');
    expect(await s.read.execute(s.ctx, s.read.parse({ jobId: 'j1' }))).toBe('<data>D-1 confirmed pending AGENT:a1</data>');
    expect(s.service.list).toHaveBeenCalledWith('p1', 'j1');
  });
  it('AC-2: rejects invalid shared ruling text naming text', () => {
    const { write } = setup();
    expect(() => write.parse({ ...input, text: 'confirm' })).toThrow(ToolInputError);
    expect(() => write.parse({ ...input, text: 'confirm' })).toThrow('text');
  });
  it('AC-3: previews job, item, parsed disposition and rechecks eligibility', async () => {
    const s = setup();
    expect(s.write).toMatchObject({ key: 'fleet.job.rule', kind: 'write' });
    const preview = await s.preview(s.ctx, s.write.parse(input));
    for (const text of ['j1', 'D-1', 'confirmed']) expect(preview).toContain(text);
    expect(s.service.preflight).toHaveBeenCalledWith('p1', 'j1', { itemId: 'D-1', text: input.text });
    expect(s.service.create).not.toHaveBeenCalled();
  });
  it('AC-5: unknown preview/execution uses distinct tool error paths and does not create', async () => {
    const s = setup(); s.service.preflight.mockRejectedValue(new NotFoundAppException({}, 'fleet.rulings.unknownItem'));
    await expect(s.preview(s.ctx, s.write.parse(input))).rejects.toEqual(new ToolInputError('unknown item'));
    await expect(s.write.execute(s.ctx, s.write.parse(input))).rejects.toEqual(new ToolActionError('unknown item'));
    expect(s.service.create).not.toHaveBeenCalled();
  });
  it('executes shared create as the same actor, rechecking target', async () => {
    const s = setup(); s.service.create.mockResolvedValue({ id: 'r1', state: 'pending' } as Awaited<ReturnType<FleetPrRulingsService['create']>>);
    expect(await s.write.execute(s.ctx, s.write.parse(input))).toContain('pending');
    expect(s.service.preflight).toHaveBeenCalled();
    expect(s.service.create).toHaveBeenCalledWith(s.ctx.actor, 'web', 'j1', { itemId: 'D-1', text: input.text });
  });
  it.each([
    ['jobId', { ...input, jobId: '' }], ['jobId', { ...input, jobId: 'x'.repeat(65) }],
    ['itemId', { ...input, itemId: '../bad' }], ['itemId', { ...input, itemId: null }],
    ['text', { ...input, text: 'confirm: ' + 'x'.repeat(2000) }], ['text', { ...input, text: '  ' }],
  ])('bounds invalid %s', (field, raw) => {
    expect(() => setup().write.parse(raw)).toThrow(field);
  });
  it('does not translate missing-job or unexpected errors into unknown item', async () => {
    const s = setup(); const error = new NotFoundAppException({}, 'fleet.jobs');
    s.service.preflight.mockRejectedValue(error);
    await expect(s.preview(s.ctx, input)).rejects.toBe(error);
    await expect(s.write.execute(s.ctx, input)).rejects.toBe(error);
  });
  it.each([
    [new ConflictAppException({}, 'fleet.rulings.notDraft'), 'job is not a draft RUN'],
    [new ConflictAppException({}, 'fleet.rulings.notLatest'), 'job is not the latest RUN'],
    [new ConflictAppException({}, 'fleet.rulings.settled'), 'item ruling is already applied'],
    [new ConflictAppException({}, 'fleet.rulings.notRulable'), 'CI items cannot be ruled'],
    [new ConflictAppException({}, 'fleet.rulings.noItemIndex'), 'pull request has no nax item index'],
    [new ValidationAppException({}, 'fleet.rulings.invalidText'), 'text'],
  ])('translates structured ruling refusal %s', async (error, reason) => {
    const s = setup(); s.service.preflight.mockRejectedValue(error);
    await expect(s.preview(s.ctx, input)).rejects.toEqual(new ToolInputError(reason));
    await expect(s.write.execute(s.ctx, input)).rejects.toEqual(new ToolActionError(reason));
  });
  it('propagates unexpected failures and refuses malformed read input', async () => {
    const s = setup(); const error = new Error('database unavailable');
    s.service.preflight.mockRejectedValue(error);
    await expect(s.write.execute(s.ctx, input)).rejects.toBe(error);
    expect(() => s.read.parse(null)).toThrow('jobId');
  });
  it('maps an unknown item discovered inside create after preflight', async () => {
    const s = setup(); s.service.create.mockRejectedValue(new NotFoundAppException({}, 'fleet.rulings.unknownItem'));
    await expect(s.write.execute(s.ctx, input)).rejects.toEqual(new ToolActionError('unknown item'));
  });
  it('AC-6: PROJECT advertises both tools', () => {
    expect(kodaToolDescriptorsFor('PROJECT').map(d => d.name)).toEqual(expect.arrayContaining(['koda_list_pr_rulings', 'koda_rule_pr_item']));
  });
  it('AC-7: WORKSPACE injects required project argument', () => {
    const d = kodaToolDescriptorsFor('WORKSPACE').find(d => d.name === 'koda_rule_pr_item');
    expect(d?.inputSchema).toMatchObject({ required: ['project', 'jobId', 'itemId', 'text'], properties: { project: { type: 'string' } } });
  });
  it('AC-8: MCP ruling description ends with shared project sentence', () => {
    expect(mcpToolDescriptors().find(d => d.name === 'koda_rule_pr_item')?.description).toMatch(/Name the project with `project` \(a slug koda_my_projects lists\)\.$/);
  });
  it('AC-9: preserves action slice before all write descriptors', () => {
    const start = KODA_TOOL_DESCRIPTORS.findIndex(d => d.name === 'koda_create_tickets');
    expect(KODA_TOOL_DESCRIPTORS.slice(start - 2, start).map(d => d.name)).toEqual(['koda_get_action', 'koda_add_comment']);
    expect(FLEET_WRITE_TOOL_DESCRIPTORS.at(-1)?.name).toBe('koda_rule_pr_item');
  });
});
