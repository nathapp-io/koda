import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  diffCatalogs,
  flattenCatalog,
  placeholders,
  type CatalogSet,
} from '../../helpers/catalog-parity';

const I18N_RESOURCES_PATH = join(__dirname, '../../../src/i18n');

// Date format patterns are not language-specific.
const ALLOWED_IDENTICAL = [
  'date.dateFormat',
  'date.dateTimeFormat',
  'date.queryDateFormat',
  'date.dateFormatWithDay',
  'date.dateTimeFromatWithDay',
];

function loadCatalogs(locale: 'en' | 'zh'): CatalogSet {
  const localePath = join(I18N_RESOURCES_PATH, locale);
  return Object.fromEntries(
    readdirSync(localePath)
      .filter((file) => file.endsWith('.json'))
      .map((file) => [
        file.slice(0, -'.json'.length),
        flattenCatalog(JSON.parse(readFileSync(join(localePath, file), 'utf8'))),
      ]),
  );
}

describe('catalog parity', () => {
  it('AC-1: reports no drift in the repository catalogs', () => {
    const diff = diffCatalogs(loadCatalogs('en'), loadCatalogs('zh'), ALLOWED_IDENTICAL);

    expect(diff).toEqual({
      missingFiles: [],
      extraFiles: [],
      missingKeys: [],
      extraKeys: [],
      untranslated: [],
      placeholderMismatches: [],
    });
  });

  it('AC-2: flattens nested catalog strings into dotted keys', () => {
    expect(flattenCatalog({ a: { b: 'x' }, c: 'y' })).toEqual({ 'a.b': 'x', c: 'y' });
  });

  it('AC-3: rejects a non-string leaf and names its dotted path', () => {
    expect(() => flattenCatalog({ a: { b: 1 } })).toThrow('a.b');
  });

  it.each([null, 'x', ['x']])('AC-4/5/6: rejects invalid root %j', (root) => {
    expect(() => flattenCatalog(root)).toThrow();
  });

  it('AC-7: extracts placeholders in order', () => {
    expect(placeholders('长度至少为 {min} 个字符')).toEqual(['{min}']);
  });

  it('AC-8: returns no placeholders when none are present', () => {
    expect(placeholders('无占位符')).toEqual([]);
  });

  it('AC-9: reports keys missing from zh', () => {
    expect(diffCatalogs({ namespace: { key: 'English' } }, { namespace: {} }, []).missingKeys).toContain(
      'namespace.key',
    );
  });

  it('AC-10: reports keys extra in zh', () => {
    expect(diffCatalogs({ namespace: {} }, { namespace: { key: '中文' } }, []).extraKeys).toContain(
      'namespace.key',
    );
  });

  it('AC-11: reports identical values not on the allow-list', () => {
    expect(
      diffCatalogs({ namespace: { key: 'English' } }, { namespace: { key: 'English' } }, []).untranslated,
    ).toContain('namespace.key');
  });

  it('AC-12: permits identical values on the allow-list', () => {
    expect(
      diffCatalogs(
        { namespace: { key: 'English' } },
        { namespace: { key: 'English' } },
        ['namespace.key'],
      ).untranslated,
    ).not.toContain('namespace.key');
  });

  it.each([
    ['AC-13: reports a dropped placeholder', 'Value {value}', 'Value'],
    ['AC-14: reports a renamed placeholder', 'Value {min}', 'Value {max}'],
    ['AC-15: reports an extra placeholder', 'Value', 'Value {extra}'],
  ])('%s', (_name, english, chinese) => {
    expect(
      diffCatalogs({ namespace: { key: english } }, { namespace: { key: chinese } }, [])
        .placeholderMismatches,
    ).toContain('namespace.key');
  });

  it('AC-16: reports a namespace file missing from zh', () => {
    expect(diffCatalogs({ namespace: {} }, {}, []).missingFiles).toContain('namespace');
  });

  it('AC-17: reports a namespace file extra in zh', () => {
    expect(diffCatalogs({}, { namespace: {} }, []).extraFiles).toContain('namespace');
  });

  it('AC-18: allow-lists exactly the five date format keys', () => {
    expect(ALLOWED_IDENTICAL).toEqual([
      'date.dateFormat',
      'date.dateTimeFormat',
      'date.queryDateFormat',
      'date.dateFormatWithDay',
      'date.dateTimeFromatWithDay',
    ]);
  });

  it('AC-19: keeps a JSON string leaf named __proto__', () => {
    const flattened = flattenCatalog(JSON.parse('{"__proto__":"English"}'));

    expect(Object.keys(flattened)).toEqual(['__proto__']);
    expect(flattened['__proto__']).toBe('English');
  });

  it('AC-20: reports an untranslated __proto__ leaf as drift', () => {
    const en: CatalogSet = { namespace: flattenCatalog(JSON.parse('{"__proto__":"English"}')) };
    const zh: CatalogSet = { namespace: flattenCatalog(JSON.parse('{"__proto__":"English"}')) };

    expect(diffCatalogs(en, zh, []).untranslated).toContain('namespace.__proto__');
  });
});
