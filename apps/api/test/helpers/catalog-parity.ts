export interface CatalogSet {
  [namespace: string]: Record<string, string>;
}

export interface CatalogDiff {
  missingFiles: string[];
  extraFiles: string[];
  missingKeys: string[];
  extraKeys: string[];
  untranslated: string[];
  placeholderMismatches: string[];
}

export function flattenCatalog(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Catalog root must be a non-array object');
  }

  // A null-prototype dictionary: `__proto__` is a legal JSON key, and assigning it on an
  // ordinary object hits the inherited setter instead of creating an own property, which
  // would drop the leaf and let the parity guard report no drift for an untranslated entry.
  const flattened: Record<string, string> = Object.create(null) as Record<string, string>;

  function visit(node: object, path: string): void {
    for (const [key, child] of Object.entries(node)) {
      const childPath = path ? `${path}.${key}` : key;
      if (typeof child === 'string') {
        // Define the own property explicitly, so the key stays an own data property
        // whatever the dictionary's prototype is.
        Object.defineProperty(flattened, childPath, {
          value: child,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      } else if (child !== null && typeof child === 'object' && !Array.isArray(child)) {
        visit(child, childPath);
      } else {
        throw new TypeError(`Catalog value at ${childPath} must be a string or nested object`);
      }
    }
  }

  visit(value, '');
  return flattened;
}

export function placeholders(value: string): string[] {
  return value.match(/\{[^{}]+\}/g) ?? [];
}

export function diffCatalogs(
  en: CatalogSet,
  zh: CatalogSet,
  allowedIdentical: readonly string[],
): CatalogDiff {
  const englishFiles = Object.keys(en);
  const chineseFiles = Object.keys(zh);
  const englishFileSet = new Set(englishFiles);
  const chineseFileSet = new Set(chineseFiles);
  const allowedSet = new Set(allowedIdentical);

  const diff: CatalogDiff = {
    missingFiles: englishFiles.filter((file) => !chineseFileSet.has(file)).sort(),
    extraFiles: chineseFiles.filter((file) => !englishFileSet.has(file)).sort(),
    missingKeys: [],
    extraKeys: [],
    untranslated: [],
    placeholderMismatches: [],
  };

  for (const namespace of englishFiles) {
    if (!chineseFileSet.has(namespace)) continue;

    const englishKeys = en[namespace];
    const chineseKeys = zh[namespace];
    const englishKeySet = new Set(Object.keys(englishKeys));
    const chineseKeySet = new Set(Object.keys(chineseKeys));

    for (const key of englishKeySet) {
      const fullKey = `${namespace}.${key}`;
      if (!chineseKeySet.has(key)) {
        diff.missingKeys.push(fullKey);
        continue;
      }

      if (englishKeys[key] === chineseKeys[key] && !allowedSet.has(fullKey)) {
        diff.untranslated.push(fullKey);
      }

      const englishPlaceholders = placeholders(englishKeys[key]).sort();
      const chinesePlaceholders = placeholders(chineseKeys[key]).sort();
      if (
        englishPlaceholders.length !== chinesePlaceholders.length ||
        englishPlaceholders.some((placeholder, index) => placeholder !== chinesePlaceholders[index])
      ) {
        diff.placeholderMismatches.push(fullKey);
      }
    }

    for (const key of chineseKeySet) {
      if (!englishKeySet.has(key)) diff.extraKeys.push(`${namespace}.${key}`);
    }
  }

  diff.missingKeys.sort();
  diff.extraKeys.sort();
  diff.untranslated.sort();
  diff.placeholderMismatches.sort();
  return diff;
}
