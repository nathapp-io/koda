import { error } from './output';

/**
 * Destructive commands need `--force`. Without it, print the hint and exit 1
 * (the same code everywhere). Returns false so callers can `return` right away:
 * command specs stub process.exit, so code after it still runs there.
 */
export function requireForce(force: unknown): boolean {
  if (force) return true;
  error('Use --force to confirm deletion');
  process.exit(1);
  return false;
}
