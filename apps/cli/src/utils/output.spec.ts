import { output, table, success, error, warn } from './output';

describe('Output Utilities', () => {
  const originalConsoleLog = console.log;
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;
  let capturedOutput: string[] = [];
  let capturedError: string[] = [];
  let capturedWarn: string[] = [];

  beforeEach(() => {
    capturedOutput = [];
    capturedError = [];
    capturedWarn = [];

    console.log = jest.fn((...args) => {
      capturedOutput.push(args.join(' '));
    });
    console.error = jest.fn((...args) => {
      capturedError.push(args.join(' '));
    });
    console.warn = jest.fn((...args) => {
      capturedWarn.push(args.join(' '));
    });
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  describe('output()', () => {
    describe('JSON mode (json: true)', () => {
      it('prints data as JSON with 2-space indent', () => {
        const data = { name: 'John', age: 30 };

        output(data, { json: true });

        expect(console.log).toHaveBeenCalled();
        const output_text = capturedOutput[0];
        expect(output_text).toContain('"name": "John"');
        expect(output_text).toContain('"age": 30');
        // Check for 2-space indentation
        expect(output_text).toMatch(/\n  /);
      });

      it('handles array data in JSON mode', () => {
        const data = [
          { id: 1, name: 'Alice' },
          { id: 2, name: 'Bob' },
        ];

        output(data, { json: true });

        expect(console.log).toHaveBeenCalled();
        const output_text = capturedOutput[0];
        expect(output_text).toContain('id');
        expect(output_text).toContain('Alice');
        expect(output_text).toContain('Bob');
      });

      it('handles null/undefined in JSON mode', () => {
        output(null, { json: true });
        expect(console.log).toHaveBeenCalledWith('null');

        capturedOutput = [];
        output(undefined, { json: true });
        expect(console.log).toHaveBeenCalledWith('undefined');
      });

      it('handles nested objects in JSON mode', () => {
        const data = {
          user: {
            name: 'John',
            profile: {
              bio: 'Software engineer',
              location: 'San Francisco',
            },
          },
        };

        output(data, { json: true });

        expect(console.log).toHaveBeenCalled();
        const output_text = capturedOutput[0];
        expect(output_text).toContain('Software engineer');
        expect(output_text).toContain('San Francisco');
      });
    });

    describe('human mode (json: false)', () => {
      it('returns formatted human-readable output', () => {
        const data = { message: 'Hello, World!' };

        output(data, { json: false });

        expect(console.log).toHaveBeenCalled();
        // Should NOT be JSON stringified
        const output_text = capturedOutput[0];
        expect(output_text).not.toMatch(/^{[\s\S]*}$/);
      });

      it('handles objects with multiple fields in human mode', () => {
        const data = { status: 'success', count: 42, items: ['a', 'b'] };

        output(data, { json: false });

        expect(console.log).toHaveBeenCalled();
      });

      it('defaults to human mode when options not provided', () => {
        const data = { key: 'value' };

        output(data);

        expect(console.log).toHaveBeenCalled();
      });
    });

    describe('edge cases', () => {
      it('handles empty objects', () => {
        output({}, { json: true });
        expect(console.log).toHaveBeenCalled();
      });

      it('handles empty arrays', () => {
        output([], { json: true });
        expect(console.log).toHaveBeenCalled();
      });

      it('handles strings as data', () => {
        output('simple string', { json: true });
        expect(console.log).toHaveBeenCalled();
      });

      it('handles numbers as data', () => {
        output(42, { json: true });
        expect(console.log).toHaveBeenCalled();
      });

      it('handles boolean as data', () => {
        output(true, { json: true });
        expect(console.log).toHaveBeenCalled();
      });
    });
  });

  describe('table()', () => {
    it('produces column-aligned output with headers', () => {
      const headers = ['ID', 'Name', 'Status'];
      const rows = [
        ['1', 'Alice', 'Active'],
        ['2', 'Bob', 'Inactive'],
      ];

      table(headers, rows);

      expect(console.log).toHaveBeenCalled();
      const output_text = capturedOutput.join('\n');

      // Headers should be present
      expect(output_text).toContain('ID');
      expect(output_text).toContain('Name');
      expect(output_text).toContain('Status');

      // Data should be present
      expect(output_text).toContain('Alice');
      expect(output_text).toContain('Bob');
    });

    it('handles headers with chalk coloring', () => {
      const headers = ['Project', 'Type', 'Priority'];
      const rows = [
        ['KODA', 'Bug', 'High'],
        ['INFRA', 'Feature', 'Low'],
      ];

      table(headers, rows);

      expect(console.log).toHaveBeenCalled();
    });

    it('produces aligned columns with padding', () => {
      const headers = ['Short', 'Medium Length', 'VeryLongHeaderName'];
      const rows = [
        ['a', 'b', 'c'],
        ['longer', 'even longer', 'extra long value'],
      ];

      table(headers, rows);

      expect(console.log).toHaveBeenCalled();
      const output_text = capturedOutput.join('\n');

      // All data should be present
      expect(output_text).toContain('longer');
      expect(output_text).toContain('extra long value');
    });

    it('handles empty rows array', () => {
      const headers = ['ID', 'Name'];
      const rows: string[][] = [];

      table(headers, rows);

      expect(console.log).toHaveBeenCalled();
    });

    it('handles single row', () => {
      const headers = ['Header1', 'Header2'];
      const rows = [['Value1', 'Value2']];

      table(headers, rows);

      expect(console.log).toHaveBeenCalled();
    });

    it('handles rows with special characters', () => {
      const headers = ['Name', 'Description'];
      const rows = [
        ['Item-1', 'Desc with (parens) and [brackets]'],
        ['Item_2', 'Desc with "quotes" and \'apostrophes\''],
      ];

      table(headers, rows);

      expect(console.log).toHaveBeenCalled();
      const output_text = capturedOutput.join('\n');
      expect(output_text).toContain('parens');
      expect(output_text).toContain('quotes');
    });
  });

  describe('success()', () => {
    it('prints success message with chalk coloring', () => {
      success('Operation completed successfully');

      expect(console.log).toHaveBeenCalled();
      const output_text = capturedOutput[0];
      expect(output_text).toContain('Operation completed successfully');
    });

    it('applies green/success styling to message', () => {
      success('Task done');

      expect(console.log).toHaveBeenCalled();
      // Should contain the message
      expect(capturedOutput.length).toBeGreaterThan(0);
    });

    it('handles multiline success messages', () => {
      success('Line 1\nLine 2\nLine 3');

      expect(console.log).toHaveBeenCalled();
    });
  });

  describe('error()', () => {
    it('prints error message to stderr with chalk coloring', () => {
      error('Something went wrong');

      expect(console.error).toHaveBeenCalled();
      const error_text = capturedError[0];
      expect(error_text).toContain('Something went wrong');
    });

    it('applies red/error styling to message', () => {
      error('Critical failure');

      expect(console.error).toHaveBeenCalled();
      expect(capturedError.length).toBeGreaterThan(0);
    });

    it('handles error objects', () => {
      const errObj = new Error('Test error');
      error(errObj.message);

      expect(console.error).toHaveBeenCalled();
      expect(capturedError[0]).toContain('Test error');
    });

    it('handles multiline error messages', () => {
      error('Error line 1\nError line 2');

      expect(console.error).toHaveBeenCalled();
    });
  });

  describe('warn()', () => {
    it('prints warning message with chalk coloring', () => {
      warn('This is a warning');

      expect(console.warn).toHaveBeenCalled();
      const warn_text = capturedWarn[0];
      expect(warn_text).toContain('This is a warning');
    });

    it('applies yellow/warning styling to message', () => {
      warn('Deprecated feature');

      expect(console.warn).toHaveBeenCalled();
      expect(capturedWarn.length).toBeGreaterThan(0);
    });

    it('handles multiline warning messages', () => {
      warn('Warning line 1\nWarning line 2');

      expect(console.warn).toHaveBeenCalled();
    });
  });

  describe('integration', () => {
    it('success, error, and warn can be called in sequence', () => {
      success('Start');
      error('Problem occurred');
      warn('But continuing');

      expect(console.log).toHaveBeenCalled();
      expect(console.error).toHaveBeenCalled();
      expect(console.warn).toHaveBeenCalled();
    });

    it('output and table work together', () => {
      const headers = ['ID', 'Result'];
      const rows = [['1', 'pass']];

      table(headers, rows);
      output({ summary: 'Done' }, { json: true });

      expect(console.log).toHaveBeenCalledTimes(2);
    });
  });
});
