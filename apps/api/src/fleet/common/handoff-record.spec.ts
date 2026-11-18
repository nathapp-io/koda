import { describe, expect, it } from 'vitest';
import { handoffRecordOf } from './handoff-record';

/**
 * US-003: the stored handoff record is read through a shape guard. A JSON column is unconstrained,
 * so a value this app did not write is absent (null), never an unchecked assertion.
 */
describe('handoffRecordOf', () => {
  const record = [
    { runId: 'run-1', file: 'result.json', mtimeMs: 1_700_000_000_000, content: '{"schemaVersion":1}' },
    { runId: 'run-1', file: 'ledger.md', mtimeMs: 1_700_000_000_000, content: '# ledger' },
  ];

  it('reads a stored record', () => {
    expect(handoffRecordOf(record)).toEqual(record);
  });

  it.each([
    ['null', null],
    ['an empty array', []],
    ['a value that is not an array', { runId: 'run-1' }],
    ['an entry that is not an object', ['run-1']],
    ['an entry without a run id', [{ file: 'result.json', mtimeMs: 1, content: '{}' }]],
    ['an entry with an empty run id', [{ runId: '', file: 'result.json', mtimeMs: 1, content: '{}' }]],
    ['an entry with an unknown file', [{ runId: 'run-1', file: 'other.json', mtimeMs: 1, content: '{}' }]],
    ['an entry with a non-integer mtime', [{ runId: 'run-1', file: 'result.json', mtimeMs: 1.5, content: '{}' }]],
    ['an entry with a negative mtime', [{ runId: 'run-1', file: 'result.json', mtimeMs: -1, content: '{}' }]],
    ['an entry with a non-string content', [{ runId: 'run-1', file: 'result.json', mtimeMs: 1, content: 7 }]],
  ])('reads %s as no record', (_name, value) => {
    expect(handoffRecordOf(value)).toBeNull();
  });
});
