import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { isIndexablePath } from '../../../src/fleet/knowledge/knowledge-allowlist';
import {
  formatReport,
  loadQuestions,
  runEval,
  scoreRun,
  type KbEvalDeps,
  type KbEvalExpected,
  type KbEvalHit,
  type KbEvalQuestion,
  type KbEvalReport,
} from '../../../scripts/kb-eval';

/** The reviewed evaluation set, committed with the spec (1c-c-D15): read-only input, never regenerated here. */
const QUESTIONS_PATH = join(__dirname, '../../kb-eval/questions.json');

function hit(owner: string, name: string, path: string, anchor?: string): KbEvalHit {
  return anchor === undefined ? { owner, name, path } : { owner, name, path, anchor };
}

/** `count` hits that match no expected entry, so the wanted hit lands at rank `count + 1`. */
function filler(count: number): KbEvalHit[] {
  return Array.from({ length: count }, (_, index) => hit('o', 'n', `docs/filler-${index}.md`));
}

function question(id: string, expected: KbEvalExpected[], text = `text of ${id}`): KbEvalQuestion {
  return { id, question: text, expected };
}

/** The API answers the Nathapp envelope: ranked hits live under `data.hits` (1c-c-D15). */
function searchResponse(hits: KbEvalHit[]): Response {
  return new Response(JSON.stringify({ ret: 0, data: { lexicalOnly: false, empty: hits.length === 0, hits } }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

interface FetchCall {
  url: string;
  init: RequestInit;
}

/** `typeof fetch` in this test program also carries Bun's `preconnect`; the eval only ever calls the function. */
type FetchStub = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function stubFetch(...responses: Array<Response | (() => Response)>): { calls: FetchCall[]; fetch: typeof fetch } {
  const calls: FetchCall[] = [];
  const queue = [...responses];
  const stub: FetchStub = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.shift() ?? searchResponse([]);
    return typeof next === 'function' ? next() : next;
  };
  return { calls, fetch: stub as typeof fetch };
}

function deps(overrides: Partial<KbEvalDeps> = {}): KbEvalDeps {
  const empty: FetchStub = async () => searchResponse([]);
  return {
    fetch: empty as typeof fetch,
    env: { KODA_EVAL_TOKEN: 't' },
    print: () => {},
    writeFile: async () => {},
    questions: [],
    ...overrides,
  };
}

function bodyOf(call: FetchCall): unknown {
  return JSON.parse(String(call.init.body)) as unknown;
}

function headersOf(call: FetchCall): Record<string, string> {
  return call.init.headers as Record<string, string>;
}

describe('kb-eval scoreRun', () => {
  it('AC-1: scores recall@5, recall@20 and mrr from the rank of the first matching hit', () => {
    const questions = [
      question('q1', [{ repo: 'o/n', path: 'docs/a.md' }]),
      question('q2', [{ repo: 'o/n', path: 'docs/b.md' }]),
    ];

    const report = scoreRun(questions, {
      q1: [...filler(2), hit('o', 'n', 'docs/a.md')],
      q2: [...filler(11), hit('o', 'n', 'docs/b.md')],
    });

    expect(report.questions).toBe(2);
    expect(report.recallAt5).toBe(0.5);
    expect(report.recallAt20).toBe(1);
    expect(report.mrr).toBeCloseTo((1 / 3 + 1 / 12) / 2, 12);
    expect(report.misses).toEqual([]);
  });

  it('AC-2: a question with no matching hit in its 20 hits is a miss and adds 0 to mrr', () => {
    const questions = [question('q1', [{ repo: 'o/n', path: 'docs/a.md' }]), question('q2', [{ repo: 'o/n', path: 'docs/gone.md' }])];

    const report = scoreRun(questions, {
      q1: [hit('o', 'n', 'docs/a.md')],
      // 20 hits, none of them the expected path (a same-named file in another repository does not count).
      q2: [...filler(19), hit('o', 'other', 'docs/gone.md')],
    });

    expect(report.misses).toEqual(['q2']);
    expect(report.recallAt20).toBe(0.5);
    expect(report.mrr).toBe(0.5);
  });

  it('AC-3: an expected anchor counts toward anchorRecall@20 only when a top-20 hit carries that path and anchor', () => {
    const expected: KbEvalExpected[] = [{ repo: 'o/n', path: 'docs/cached.md', anchor: 'cache' }];
    const questions = [question('q1', expected), question('q2', expected)];

    const report = scoreRun(questions, {
      q1: [hit('o', 'n', 'docs/cached.md', 'other-anchor')],
      q2: [hit('o', 'n', 'docs/cached.md', 'cache')],
    });

    // The path alone still counts for recall@20 (both questions), the anchor only for q2.
    expect(report.recallAt5).toBe(1);
    expect(report.recallAt20).toBe(1);
    expect(report.anchorRecallAt20).toBe(0.5);
    expect(report.misses).toEqual([]);
  });

  it('AC-3: an anchored hit outside the first 20 does not count toward anchorRecall@20 and misses the question', () => {
    const questions = [question('q1', [{ repo: 'o/n', path: 'docs/cached.md', anchor: 'cache' }])];

    const report = scoreRun(questions, { q1: [...filler(20), hit('o', 'n', 'docs/cached.md', 'cache')] });

    expect(report.recallAt20).toBe(0);
    expect(report.anchorRecallAt20).toBe(0);
    expect(report.misses).toEqual(['q1']);
  });

  it('AC-4: a question with two expected entries counts as found when either one matches', () => {
    const questions = [
      question('q1', [
        { repo: 'o/n', path: 'docs/a.md' },
        { repo: 'o/n', path: 'docs/b.md' },
      ]),
    ];

    const report = scoreRun(questions, { q1: [hit('o', 'n', 'docs/other.md'), hit('o', 'n', 'docs/b.md')] });

    expect(report.recallAt5).toBe(1);
    expect(report.recallAt20).toBe(1);
    expect(report.mrr).toBeCloseTo(1 / 2, 12);
    expect(report.misses).toEqual([]);
  });

  it('scores an empty run as zeroes rather than dividing by zero', () => {
    const report = scoreRun([], {});

    expect(report).toEqual({ questions: 0, recallAt5: 0, recallAt20: 0, mrr: 0, anchorRecallAt20: 0, misses: [] });
  });
});

describe('kb-eval runEval', () => {
  it('AC-5: posts every question to the project search route with the bearer token and limit 20', async () => {
    const questions = [question('q1', [{ repo: 'o/n', path: 'docs/a.md' }], 'how is auth configured?'), question('q2', [], 'how are tickets numbered?')];
    const { calls, fetch } = stubFetch(searchResponse([]), searchResponse([]));

    await runEval(['--base-url', 'http://k', '--project', 'koda-dogfood'], deps({ fetch, questions }));

    expect(calls).toHaveLength(2);
    expect(calls.map((call) => call.url)).toEqual(questions.map(() => 'http://k/api/projects/koda-dogfood/knowledge/search'));
    expect(calls.map((call) => call.init.method)).toEqual(['POST', 'POST']);
    expect(calls.map((call) => headersOf(call)['Authorization'])).toEqual(['Bearer t', 'Bearer t']);
    // US-005 AC-14: the evaluation reads repository docs only, so its scores stay comparable to the 3c-1 baseline.
    expect(calls.map(bodyOf)).toEqual(questions.map((asked) => ({ query: asked.question, limit: 20, source: 'docs' })));
  });

  it('AC-6: a 500 answer misses the question, prints the status and the run continues', async () => {
    const questions = [question('q1', [{ repo: 'o/n', path: 'docs/a.md' }]), question('q2', [{ repo: 'o/n', path: 'docs/b.md' }])];
    const { calls, fetch } = stubFetch(
      () => new Response('kaboom', { status: 500 }),
      searchResponse([...filler(2), hit('o', 'n', 'docs/b.md')]),
    );
    const printed: string[] = [];

    const report = await runEval(
      ['--base-url', 'http://k', '--project', 'koda-dogfood'],
      deps({ fetch, questions, print: (line) => printed.push(line) }),
    );

    expect(calls).toHaveLength(2);
    expect(report.questions).toBe(2);
    expect(report.misses).toEqual(['q1']);
    expect(report.recallAt5).toBe(0.5);
    expect(printed.join('\n')).toContain('500');
    expect(printed.join('\n')).toContain('q1');
  });

  it('scores the ranked hits the envelope carries', async () => {
    const questions = [question('q1', [{ repo: 'o/n', path: 'docs/a.md' }])];
    const { fetch } = stubFetch(searchResponse([hit('o', 'n', 'docs/a.md')]));

    const report = await runEval(['--base-url', 'http://k', '--project', 'p'], deps({ fetch, questions }));

    expect(report.recallAt5).toBe(1);
    expect(report.mrr).toBe(1);
  });

  it('records a miss when the body is not a search result', async () => {
    const questions = [question('q1', [{ repo: 'o/n', path: 'docs/a.md' }])];
    const { fetch } = stubFetch(new Response('<html>nope</html>', { status: 200 }));
    const printed: string[] = [];

    const report = await runEval(
      ['--base-url', 'http://k', '--project', 'p'],
      deps({ fetch, questions, print: (line) => printed.push(line) }),
    );

    expect(report.misses).toEqual(['q1']);
    expect(printed.join('\n')).toContain('q1');
  });

  it('prints the report and writes it as JSON when --out is given', async () => {
    const questions = [question('q1', [{ repo: 'o/n', path: 'docs/a.md' }])];
    const { calls, fetch } = stubFetch(searchResponse([hit('o', 'n', 'docs/a.md')]));
    const printed: string[] = [];
    const written: Array<{ path: string; text: string }> = [];

    const report = await runEval(
      ['--base-url', 'http://k/', '--project', 'p', '--out', 'report.json'],
      deps({ fetch, questions, print: (line) => printed.push(line), writeFile: async (path, text) => void written.push({ path, text }) }),
    );

    expect(printed.join('\n')).toContain('recall@20');
    expect(written.map((entry) => entry.path)).toEqual(['report.json']);
    expect(written.map((entry) => JSON.parse(entry.text) as KbEvalReport)).toEqual([report]);
    // A trailing slash on the base url must not double up in the request path.
    expect(calls.map((call) => call.url)).toEqual(['http://k/api/projects/p/knowledge/search']);
  });

  it('refuses to start without a token or the required flags', async () => {
    const questions = [question('q1', [])];
    const { calls, fetch } = stubFetch(searchResponse([]));

    await expect(runEval(['--base-url', 'http://k', '--project', 'p'], deps({ fetch, questions, env: {} }))).rejects.toThrow(
      'KODA_EVAL_TOKEN',
    );
    await expect(runEval(['--project', 'p'], deps({ fetch, questions }))).rejects.toThrow('--base-url');
    await expect(runEval(['--base-url', 'http://k'], deps({ fetch, questions }))).rejects.toThrow('--project');
    await expect(runEval(['--base-url', 'http://k', '--project', 'p', '--nope', 'x'], deps({ fetch, questions }))).rejects.toThrow(
      '--nope',
    );
    expect(calls).toHaveLength(0);
  });
});

describe('kb-eval question fixture', () => {
  const questions = JSON.parse(readFileSync(QUESTIONS_PATH, 'utf8')) as KbEvalQuestion[];

  it('AC-7: holds 40 questions with 40 unique ids and non-empty text', () => {
    expect(questions).toHaveLength(40);

    const ids = questions.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(40);

    for (const entry of questions) {
      expect(entry.id.trim().length, `id of ${JSON.stringify(entry)}`).toBeGreaterThan(0);
      expect(entry.question.trim().length, `question of ${entry.id}`).toBeGreaterThan(0);
    }
  });

  it('AC-7: every question has an expected entry on an indexable path', () => {
    for (const entry of questions) {
      expect(entry.expected.length, `expected of ${entry.id}`).toBeGreaterThan(0);
      expect(entry.expected.some((want) => isIndexablePath(want.path)), `indexable path of ${entry.id}`).toBe(true);
    }
  });

  it('scores the whole fixture without throwing', () => {
    const report: KbEvalReport = scoreRun(questions, {});

    expect(report.questions).toBe(40);
    expect(report.misses).toHaveLength(40);
    expect(report.recallAt20).toBe(0);
  });
});

describe('kb-eval module surface', () => {
  it('prints one line per metric', () => {
    const report: KbEvalReport = {
      questions: 40,
      recallAt5: 0.75,
      recallAt20: 0.975,
      mrr: 0.81234,
      anchorRecallAt20: 0.9,
      misses: ['q03'],
    };

    expect(formatReport(report)).toEqual([
      'kb-eval: questions 40',
      'kb-eval: recall@5 0.750',
      'kb-eval: recall@20 0.975',
      'kb-eval: mrr 0.8123',
      'kb-eval: anchorRecall@20 0.900',
      'kb-eval: misses q03',
    ]);
    expect(formatReport({ ...report, misses: [] }).at(-1)).toBe('kb-eval: misses none');
  });

  it('loads the committed fixture and rejects a body that is not an array', () => {
    expect(loadQuestions(QUESTIONS_PATH)).toHaveLength(40);

    const dir = mkdtempSync(join(tmpdir(), 'kb-eval-'));
    try {
      const good = join(dir, 'questions.json');
      writeFileSync(good, JSON.stringify([question('q1', [{ repo: 'o/n', path: 'docs/a.md' }])]));
      expect(loadQuestions(good).map((entry) => entry.id)).toEqual(['q1']);

      const bad = join(dir, 'bad.json');
      writeFileSync(bad, JSON.stringify({ questions: [] }));
      expect(() => loadQuestions(bad)).toThrow(`${bad} must hold an array of questions`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
