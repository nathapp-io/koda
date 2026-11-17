import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * US-004: the six refusals the handoff create answers with are translated in both locales. The
 * key is `fleet.flows.<name>`, and every one of them is an `AppException`/`ConflictAppException`,
 * so the sentence lives one code deeper (`409` or `422`).
 */
type Catalog = Record<string, Record<string, string>>;
const load = (lang: string): Catalog => JSON.parse(readFileSync(join(__dirname, '../../../src/i18n', lang, 'fleet.json'), 'utf8')) as Catalog;

const KEYS: Array<[string, string]> = [
  ['handoffHeadMoved', '409'],
  ['prdMissing', '422'],
  ['handoffBranchMismatch', '422'],
  ['handoffStoriesPending', '422'],
  ['handoffPrOpen', '409'],
  ['branchBusy', '409'],
];

describe('fleet flow handoff translation keys', () => {
  it.each(KEYS)('US-004 AC-15: fleet.flows.%s is translated in en and zh', (key, code) => {
    const english = load('en').flows?.[key]?.[code];
    const chinese = load('zh').flows?.[key]?.[code];
    expect(english?.trim()).toBeTruthy();
    expect(chinese?.trim()).toBeTruthy();
    // The two locales must not answer the same sentence (the catalog parity spec checks this too).
    expect(chinese).not.toBe(english);
  });

  it('US-004 AC-15: the handoff refusals keep the placeholders their arguments fill', () => {
    const en = load('en').flows ?? {};
    expect(en.prdMissing?.['422']).toContain('{path}');
    expect(en.handoffStoriesPending?.['422']).toContain('{storyIds}');
    expect(en.handoffPrOpen?.['409']).toContain('{prNumber}');
    expect(en.branchBusy?.['409']).toContain('{flowId}');
  });
});
