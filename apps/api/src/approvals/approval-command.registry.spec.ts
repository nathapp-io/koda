import { ApprovalCommandRegistry, type ApprovalCommand } from './approval-command.registry';

/** P3 approval core (US-007): the singleton map from an approvable catalog key to its executor. */
function command(key: string, variant?: string): ApprovalCommand {
  return {
    key,
    ...(variant === undefined ? {} : { variant }),
    parse: (input: unknown) => input,
    execute: async () => 'done',
  };
}

describe('ApprovalCommandRegistry', () => {
  let registry: ApprovalCommandRegistry;
  beforeEach(() => {
    registry = new ApprovalCommandRegistry();
  });

  it('returns the registered command for its key', () => {
    const labelDelete = command('label.delete');
    registry.register(labelDelete);

    expect(registry.get('label.delete')).toBe(labelDelete);
  });

  it('returns undefined for a key with no command', () => {
    expect(registry.get('label.delete')).toBeUndefined();
  });

  it('refuses a catalog key that is not approvable', () => {
    expect(() => registry.register(command('ticket.read')))
      .toThrow('approval command key is not approvable: ticket.read');
  });

  it('refuses a key the catalog does not know', () => {
    expect(() => registry.register(command('no.such.key')))
      .toThrow('approval command key is not approvable: no.such.key');
  });

  it('keeps the first command when a second registration is refused', () => {
    const first = command('label.delete');
    registry.register(first);
    expect(() => registry.register(command('label.delete'))).toThrow();

    expect(registry.get('label.delete')).toBe(first);
  });

  it('AC-1: registers a primary command and a variant of one key', () => {
    registry.register(command('label.delete'));

    expect(() => registry.register(command('label.delete', 'rest:labels.delete'))).not.toThrow();
  });

  it('AC-2: answers the primary command and the variant command for their own pair', () => {
    const primary = command('label.delete');
    const variant = command('label.delete', 'rest:labels.delete');
    registry.register(primary);
    registry.register(variant);

    expect(registry.get('label.delete')).toBe(primary);
    expect(registry.get('label.delete', 'rest:labels.delete')).toBe(variant);
  });

  it('AC-3: answers undefined for a variant that is not registered', () => {
    registry.register(command('label.delete'));
    registry.register(command('label.delete', 'rest:labels.delete'));

    expect(registry.get('label.delete', 'rest:other')).toBeUndefined();
  });

  it('AC-4: refuses a second command for the same (key, variant) pair', () => {
    registry.register(command('label.delete', 'rest:labels.delete'));

    expect(() => registry.register(command('label.delete', 'rest:labels.delete')))
      .toThrow('approval command already registered: label.delete#rest:labels.delete');
  });

  it('AC-5: refuses an empty variant', () => {
    expect(() => registry.register(command('label.delete', '')))
      .toThrow('approval command variant is invalid: label.delete');
    expect(registry.get('label.delete')).toBeUndefined();
  });

  it('AC-6: refuses a variant longer than 100 characters', () => {
    expect(() => registry.register(command('label.delete', 'r'.repeat(101))))
      .toThrow('approval command variant is invalid: label.delete');
    expect(registry.get('label.delete')).toBeUndefined();
  });

  it('accepts a variant of exactly 100 characters', () => {
    const variant = command('label.delete', 'r'.repeat(100));

    expect(() => registry.register(variant)).not.toThrow();
    expect(registry.get('label.delete', 'r'.repeat(100))).toBe(variant);
  });

  it('AC-15: refuses a second primary command for the same key', () => {
    registry.register(command('label.delete'));

    expect(() => registry.register(command('label.delete')))
      .toThrow('approval command already registered: label.delete');
  });
});
