import * as path from 'path';
import * as fs from 'fs';

const I18N_BASE = path.resolve(__dirname, '../../src/i18n');
const LOCALES = ['en', 'zh'];
const NAMESPACES = ['common', 'auth', 'tickets', 'projects', 'agents', 'comments'];

describe('i18n translation files', () => {
  describe('directory structure', () => {
    it('should have src/i18n directory', () => {
      expect(fs.existsSync(I18N_BASE)).toBe(true);
    });

    it.each(LOCALES)('should have locale directory: %s', (locale) => {
      expect(fs.existsSync(path.join(I18N_BASE, locale))).toBe(true);
    });
  });

  describe.each(LOCALES)('locale: %s', (locale) => {
    it.each(NAMESPACES)(
      `should have ${locale}/%s.json`,
      (ns) => {
        const filePath = path.join(I18N_BASE, locale, `${ns}.json`);
        expect(fs.existsSync(filePath)).toBe(true);
      },
    );

    it.each(NAMESPACES)(
      `${locale}/%s.json should be valid JSON`,
      (ns) => {
        const filePath = path.join(I18N_BASE, locale, `${ns}.json`);
        if (!fs.existsSync(filePath)) {
          // File missing — file existence test already covers this; skip parse
          return;
        }
        expect(() => JSON.parse(fs.readFileSync(filePath, 'utf8'))).not.toThrow();
      },
    );
  });

  describe('en/common.json required keys', () => {
    let commonJson: Record<string, unknown>;

    beforeAll(() => {
      const filePath = path.join(I18N_BASE, 'en', 'common.json');
      commonJson = fs.existsSync(filePath)
        ? (JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>)
        : {};
    });

    const requiredValidationKeys = [
      'required',
      'isEmail',
      'minLength',
      'maxLength',
    ];

    it.each(requiredValidationKeys)(
      'should have validation.%s key',
      (key) => {
        const validation = commonJson['validation'] as Record<string, unknown> | undefined;
        expect(validation?.[key]).toBeDefined();
      },
    );

    const requiredErrorKeys = ['notFound', 'forbidden', 'unauthorized'];

    it.each(requiredErrorKeys)(
      'should have errors.%s key',
      (key) => {
        const errors = commonJson['errors'] as Record<string, unknown> | undefined;
        expect(errors?.[key]).toBeDefined();
      },
    );
  });
});
