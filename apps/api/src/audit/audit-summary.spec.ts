import { describe, expect, it } from 'vitest';
import { fieldsSummary } from './audit-summary';

describe('fieldsSummary', () => {
  it('AC-14: returns own field names sorted', () => expect(fieldsSummary({ title: 'x', priority: 'HIGH' })).toBe('fields: priority, title'));
  it('AC-15: excludes undefined fields', () => expect(fieldsSummary({ title: 'x', description: undefined })).toBe('fields: title'));
  it('AC-16: returns undefined when no fields are present', () => expect(fieldsSummary({})).toBeUndefined());
  it('AC-17: never exposes field values', () => expect(fieldsSummary({ title: 'secret-title' })).not.toContain('secret-title'));
});
