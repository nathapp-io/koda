// Mock chalk before importing output module
jest.mock('chalk', () => ({
  __esModule: true,
  default: {
    green: (str: string) => str,
    red: (str: string) => str,
    yellow: (str: string) => str,
    cyan: {
      bold: (str: string) => str,
    },
    gray: (str: string) => str,
  },
}));

import { output, table, success, error, warn } from './output';

describe('output', () => {
  const originalLog = console.log;
  const originalError = console.error;

  let logOutput: string[];
  let errorOutput: string[];

  beforeEach(() => {
    logOutput = [];
    errorOutput = [];

    console.log = jest.fn((...args) => {
      logOutput.push(args.join(' '));
    });

    console.error = jest.fn((...args) => {
      errorOutput.push(args.join(' '));
    });
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
  });

  describe('output function', () => {
    it('prints JSON when json option is true', () => {
      const data = { name: 'test', value: 123 };
      output(data, { json: true });

      expect(logOutput.length).toBe(1);
      const parsed = JSON.parse(logOutput[0]);
      expect(parsed).toEqual(data);
    });

    it('prints pretty-printed format when json is false', () => {
      const data = { name: 'test', value: 123 };
      output(data, { json: false });

      expect(logOutput.length).toBeGreaterThan(0);
      // Should not be strict JSON but formatted
      expect(logOutput[0]).not.toBe(JSON.stringify(data));
    });

    it('prints pretty-printed format by default when json option not provided', () => {
      const data = { key: 'value' };
      output(data);

      expect(logOutput.length).toBeGreaterThan(0);
    });

    it('handles arrays in JSON mode', () => {
      const data = [{ id: 1, name: 'item1' }, { id: 2, name: 'item2' }];
      output(data, { json: true });

      const parsed = JSON.parse(logOutput[0]);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toEqual(data);
    });

    it('handles arrays in pretty-print mode', () => {
      const data = [{ id: 1, name: 'item1' }, { id: 2, name: 'item2' }];
      output(data, { json: false });

      expect(logOutput.length).toBeGreaterThan(0);
    });

    it('handles empty arrays', () => {
      const data: unknown[] = [];
      output(data, { json: true });

      const parsed = JSON.parse(logOutput[0]);
      expect(parsed).toEqual([]);
    });

    it('handles null and undefined gracefully', () => {
      output(null, { json: true });
      expect(logOutput.length).toBeGreaterThan(0);
    });
  });

  describe('table function', () => {
    it('renders column headers', () => {
      const headers = ['ID', 'Name', 'Status'];
      const rows = [['1', 'Item1', 'Active']];
      table(headers, rows);

      const output = logOutput.join('\n');
      expect(output).toContain('ID');
      expect(output).toContain('Name');
      expect(output).toContain('Status');
    });

    it('renders table rows', () => {
      const headers = ['ID', 'Name'];
      const rows = [['1', 'Item1'], ['2', 'Item2']];
      table(headers, rows);

      const output = logOutput.join('\n');
      expect(output).toContain('Item1');
      expect(output).toContain('Item2');
    });

    it('renders single row', () => {
      const headers = ['ID', 'Name'];
      const rows = [['1', 'Item1']];
      table(headers, rows);

      expect(logOutput.length).toBeGreaterThan(0);
    });

    it('renders multiple rows', () => {
      const headers = ['ID', 'Name'];
      const rows = [
        ['1', 'Item1'],
        ['2', 'Item2'],
        ['3', 'Item3'],
      ];
      table(headers, rows);

      const output = logOutput.join('\n');
      expect(output).toContain('Item1');
      expect(output).toContain('Item2');
      expect(output).toContain('Item3');
    });

    it('aligns columns properly', () => {
      const headers = ['ID', 'Name'];
      const rows = [
        ['1', 'Short'],
        ['999', 'VeryLongNameHere'],
      ];
      table(headers, rows);

      // Just check that it doesn't error and produces output
      expect(logOutput.length).toBeGreaterThan(0);
    });

    it('handles empty rows array', () => {
      const headers = ['ID', 'Name'];
      const rows: string[][] = [];
      table(headers, rows);

      const output = logOutput.join('\n');
      expect(output).toContain('ID');
      expect(output).toContain('Name');
    });

    it('renders headers in cyan bold or similar styling', () => {
      const headers = ['ID', 'Name'];
      const rows = [['1', 'Item1']];
      table(headers, rows);

      // Just verify it produces output; actual styling checked via chalk integration
      expect(logOutput.length).toBeGreaterThan(0);
    });
  });

  describe('success function', () => {
    it('prints colored success message', () => {
      success('Operation successful');

      expect(logOutput.length).toBeGreaterThan(0);
      const output = logOutput.join('\n');
      expect(output).toContain('Operation successful');
    });

    it('uses stdout, not stderr', () => {
      success('Success message');

      expect(logOutput.length).toBeGreaterThan(0);
      expect(errorOutput.length).toBe(0);
    });

    it('handles different messages', () => {
      success('First message');
      success('Second message');

      expect(logOutput.length).toBe(2);
    });
  });

  describe('error function', () => {
    it('prints colored error message to stderr', () => {
      error('Something went wrong');

      expect(errorOutput.length).toBeGreaterThan(0);
      const output = errorOutput.join('\n');
      expect(output).toContain('Something went wrong');
    });

    it('uses stderr, not stdout', () => {
      error('Error message');

      expect(errorOutput.length).toBeGreaterThan(0);
      expect(logOutput.length).toBe(0);
    });

    it('handles different error messages', () => {
      error('Error 1');
      error('Error 2');

      expect(errorOutput.length).toBe(2);
    });
  });

  describe('warn function', () => {
    it('prints colored warning message', () => {
      warn('Warning: something might happen');

      expect(errorOutput.length).toBeGreaterThan(0);
      const output = errorOutput.join('\n');
      expect(output).toContain('Warning: something might happen');
    });

    it('uses stderr, not stdout', () => {
      warn('Warning message');

      expect(errorOutput.length).toBeGreaterThan(0);
      expect(logOutput.length).toBe(0);
    });

    it('handles different warning messages', () => {
      warn('Warn 1');
      warn('Warn 2');

      expect(errorOutput.length).toBe(2);
    });
  });
});
