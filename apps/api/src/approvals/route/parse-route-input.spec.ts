import { ValidationAppException } from '@nathapp/nestjs-common';
import { parseRouteInput } from './parse-route-input';

function expectInvalidInput(input: unknown, names: readonly string[]): void {
  let error: unknown;
  try {
    parseRouteInput(input, names);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ValidationAppException);
  expect((error as ValidationAppException).prefix).toBe('approvals.invalidInput');
}

describe('parseRouteInput', () => {
  it('AC-1: returns exactly the requested members', () => {
    expect(parseRouteInput({ projectId: 'p1', id: 'b1', extra: 1 }, ['projectId', 'id']))
      .toEqual({ projectId: 'p1', id: 'b1' });
  });

  it.each([
    ['AC-2', { projectId: 'p1' }, ['projectId', 'id']],
    ['AC-3', { id: '' }, ['id']],
    ['AC-4', ['b1'], ['id']],
    ['AC-5', { id: 7 }, ['id']],
    ['AC-9', null, ['id']],
    ['AC-10', 'b1', ['id']],
  ])('%s: rejects malformed route input', (_ac, input, names) => {
    expectInvalidInput(input, names);
  });
});

it('rejects inherited members and preserves an own __proto__ string', () => {
  expect(() => parseRouteInput(Object.create({ id: 'inherited' }), ['id'])).toThrow(ValidationAppException);
  const parsed = parseRouteInput(JSON.parse('{"__proto__":"value"}'), ['__proto__']);
  expect(Object.hasOwn(parsed, '__proto__')).toBe(true);
  expect(parsed.__proto__).toBe('value');
});
