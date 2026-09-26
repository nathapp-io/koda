import { compareEventsDesc } from './event-order';

const at = (iso: string, id: string) => ({ createdAt: new Date(iso), id });

describe('compareEventsDesc', () => {
  it('orders newer first', () => {
    const rows = [at('2026-01-01T00:00:00Z', 'a'), at('2026-01-02T00:00:00Z', 'b')];
    expect(rows.sort(compareEventsDesc).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('breaks a createdAt tie by id descending, by code unit', () => {
    const t = '2026-01-01T00:00:00.000Z';
    const rows = [at(t, 'c1'), at(t, 'c9'), at(t, 'ca')];
    expect(rows.sort(compareEventsDesc).map((r) => r.id)).toEqual(['ca', 'c9', 'c1']);
  });
});
