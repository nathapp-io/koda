import { AssistantToolRegistry } from './assistant-tool.registry';
import type { AssistantTool } from './assistant-tool.types';

const tool = (name: string): AssistantTool => ({
  descriptor: { name, description: 'd', inputSchema: {} },
  key: 'ticket.read',
  parse: (input) => input,
  execute: async () => 'ok',
});

describe('AssistantToolRegistry', () => {
  it('returns a registered tool by name and undefined for an unknown name', () => {
    const registry = new AssistantToolRegistry();
    const a = tool('koda_a');
    registry.register(a, tool('koda_b'));
    expect(registry.get('koda_a')).toBe(a);
    expect(registry.get('koda_missing')).toBeUndefined();
  });

  it('throws on a duplicate name', () => {
    const registry = new AssistantToolRegistry();
    registry.register(tool('koda_a'));
    expect(() => registry.register(tool('koda_a'))).toThrow(Error);
    // US-007 AC-10: the refusal names the tool that is already registered.
    expect(() => registry.register(tool('koda_a'))).toThrow('koda tool already registered: koda_a');
  });

  it('AC-1: lists the registered tools in registration order', () => {
    const registry = new AssistantToolRegistry();
    const a = tool('koda_a');
    const b = tool('koda_b');
    registry.register(a);
    registry.register(b);
    expect(registry.list()).toEqual([a, b]);
  });

  it('AC-2: lists nothing on a new registry', () => {
    expect(new AssistantToolRegistry().list()).toEqual([]);
  });
});
