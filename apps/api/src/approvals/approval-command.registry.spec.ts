import { ApprovalCommandRegistry, type ApprovalCommand } from './approval-command.registry';

/** P3 approval core (US-007): the singleton map from an approvable catalog key to its executor. */
function command(key: string): ApprovalCommand {
  return { key, parse: (input: unknown) => input, execute: async () => 'done' };
}

describe('ApprovalCommandRegistry', () => {
  let registry: ApprovalCommandRegistry;
  beforeEach(() => {
    registry = new ApprovalCommandRegistry();
  });

  it('AC-1: returns the registered command for its key', () => {
    const labelDelete = command('label.delete');
    registry.register(labelDelete);

    expect(registry.get('label.delete')).toBe(labelDelete);
  });

  it('AC-2: returns undefined for a key with no command', () => {
    expect(registry.get('label.delete')).toBeUndefined();
  });

  it('AC-3: refuses a catalog key that is not approvable', () => {
    expect(() => registry.register(command('ticket.read')))
      .toThrow('approval command key is not approvable: ticket.read');
  });

  it('AC-4: refuses a key the catalog does not know', () => {
    expect(() => registry.register(command('no.such.key')))
      .toThrow('approval command key is not approvable: no.such.key');
  });

  it('AC-5: refuses a second command for the same key', () => {
    registry.register(command('label.delete'));

    expect(() => registry.register(command('label.delete')))
      .toThrow('approval command already registered: label.delete');
  });

  it('keeps the first command when a second registration is refused', () => {
    const first = command('label.delete');
    registry.register(first);
    expect(() => registry.register(command('label.delete'))).toThrow();

    expect(registry.get('label.delete')).toBe(first);
  });
});
