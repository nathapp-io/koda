import { isJsonMode, setJsonMode } from './json-mode';

describe('json-mode', () => {
  afterEach(() => {
    setJsonMode(false);
  });

  it('defaults to false', () => {
    expect(isJsonMode()).toBe(false);
  });

  it('reflects the last value passed to setJsonMode', () => {
    setJsonMode(true);
    expect(isJsonMode()).toBe(true);

    setJsonMode(false);
    expect(isJsonMode()).toBe(false);
  });
});
