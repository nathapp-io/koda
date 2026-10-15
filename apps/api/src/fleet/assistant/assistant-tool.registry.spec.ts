import { AssistantToolRegistry } from './assistant-tool.registry';
import type { AssistantTool } from './assistant-tool.types';

const tool = (name: string): AssistantTool => ({
  descriptor: { name, description: 'd', inputSchema: {} },
  permission: { kind: 'member' },
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
  });
});
