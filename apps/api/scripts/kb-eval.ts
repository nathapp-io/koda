/**
 * Repository-knowledge evaluation script (1c-c-R4, 1c-c-D15).
 *
 * `apps/api/test/kb-eval/questions.json` is the reviewed, committed 40-question set: it names the repository
 * docs that should answer each question. `scoreRun` turns the answers (a question id mapped to its ranked
 * search hits) into recall@5, recall@20, MRR and anchor recall@20; `runEval` is the CLI body that fills those
 * answers from `POST /api/projects/:slug/knowledge/search` with an injected fetch, printer and writer, so the
 * unit tests never touch the network. Both are pure with respect to module import: the fixture is only read by
 * `main`, behind the CLI entry guard at the bottom of this file.
 *
 * Usage: `KODA_EVAL_TOKEN=<user access token or API key> bun run kb:eval -- --base-url <url> --project <slug>
 * [--out <file>]`
 */

import { readFileSync } from 'fs';
import { writeFile } from 'fs/promises';
import { join } from 'path';

/** Ranked hits the search route is asked for: the deeper of the two recall windows. */
export const KB_EVAL_HIT_LIMIT = 20;
export const KB_EVAL_RECALL_AT_5 = 5;
export const KB_EVAL_RECALL_AT_20 = 20;
export const KB_EVAL_TOKEN_ENV = 'KODA_EVAL_TOKEN';

/** One document that should answer a question, as the fixture spells it. */
export interface KbEvalExpected {
  /** `owner/name` of the project repository holding the document. */
  repo: string;
  path: string;
  anchor?: string;
}

export interface KbEvalQuestion {
  id: string;
  question: string;
  expected: KbEvalExpected[];
}

/** A search hit reduced to the fields a citation carries (`<owner>/<name>:<path>#<anchor>`). */
export interface KbEvalHit {
  owner: string;
  name: string;
  path: string;
  anchor?: string;
}

/** A question id mapped to the ranked hits the search route answered for it. */
export type KbEvalAnswers = Record<string, readonly KbEvalHit[]>;

export interface KbEvalReport {
  questions: number;
  recallAt5: number;
  recallAt20: number;
  mrr: number;
  anchorRecallAt20: number;
  misses: string[];
}

export interface KbEvalDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
  print: (line: string) => void;
  writeFile: (path: string, text: string) => Promise<void>;
  questions: KbEvalQuestion[];
}

const FLAGS = ['--base-url', '--project', '--out'] as const;
const DEFAULT_QUESTIONS_PATH = join(__dirname, '..', 'test', 'kb-eval', 'questions.json');

interface KbEvalArgs {
  baseUrl: string;
  project: string;
  out?: string;
}

/** A hit matches an expected entry when `<owner>/<name>` equals `repo` and `path` equals `path`. */
function matches(hit: KbEvalHit, expected: KbEvalExpected): boolean {
  return `${hit.owner}/${hit.name}` === expected.repo && hit.path === expected.path;
}

/**
 * The anchor clause of an expected entry: a hit satisfies it when the entry names no anchor, or when the hit
 * carries that anchor. An empty anchor is "the document summary chunk" and never satisfies a named one.
 */
function satisfiesAnchor(hit: KbEvalHit, expected: KbEvalExpected): boolean {
  return expected.anchor === undefined || hit.anchor === expected.anchor;
}

/** Rank of the first hit that matches any expected entry, or 0 when none does. */
function firstMatchRank(hits: readonly KbEvalHit[], expected: readonly KbEvalExpected[]): number {
  const index = hits.findIndex((hit) => expected.some((want) => matches(hit, want)));
  return index < 0 ? 0 : index + 1;
}

function rate(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}

/**
 * Deterministic scoring over `answers` (1c-c-D15). A question counts toward recall@k when any of its expected
 * `{repo, path}` pairs appears among its first k hits; `mrr` averages `1 / rank` of the first matching hit
 * (0 when there is none); `anchorRecallAt20` additionally requires the anchor inside the first 20 hits;
 * `misses` lists the ids with no match in the first 20.
 */
export function scoreRun(questions: readonly KbEvalQuestion[], answers: KbEvalAnswers): KbEvalReport {
  let recallAt5 = 0;
  let recallAt20 = 0;
  let anchorRecallAt20 = 0;
  let reciprocalRankSum = 0;
  const misses: string[] = [];

  for (const entry of questions) {
    const hits = answers[entry.id] ?? [];
    const rank = firstMatchRank(hits, entry.expected);
    if (rank > 0) reciprocalRankSum += 1 / rank;
    if (rank > 0 && rank <= KB_EVAL_RECALL_AT_5) recallAt5 += 1;
    if (rank > 0 && rank <= KB_EVAL_RECALL_AT_20) recallAt20 += 1;
    else misses.push(entry.id);
    // Bounded to the first 20 hits: an anchored match outside the window is not found (1c-c-D15).
    if (hits.slice(0, KB_EVAL_RECALL_AT_20).some((hit) => entry.expected.some((want) => matches(hit, want) && satisfiesAnchor(hit, want)))) {
      anchorRecallAt20 += 1;
    }
  }

  const total = questions.length;
  return {
    questions: total,
    recallAt5: rate(recallAt5, total),
    recallAt20: rate(recallAt20, total),
    mrr: rate(reciprocalRankSum, total),
    anchorRecallAt20: rate(anchorRecallAt20, total),
    misses,
  };
}

/** The report as printed lines: four decimals of MRR, three everywhere else. */
export function formatReport(report: KbEvalReport): string[] {
  return [
    `kb-eval: questions ${report.questions}`,
    `kb-eval: recall@5 ${report.recallAt5.toFixed(3)}`,
    `kb-eval: recall@20 ${report.recallAt20.toFixed(3)}`,
    `kb-eval: mrr ${report.mrr.toFixed(4)}`,
    `kb-eval: anchorRecall@20 ${report.anchorRecallAt20.toFixed(3)}`,
    `kb-eval: misses ${report.misses.length === 0 ? 'none' : report.misses.join(', ')}`,
  ];
}

/**
 * The CLI body (1c-c-D15): one search call per question, then the report. A question the search route cannot
 * answer (non-200, a non-JSON body, a transport failure) is recorded as a miss and the reason printed; the run
 * continues, so one bad question cannot discard a 40-question evaluation.
 */
export async function runEval(argv: readonly string[], deps: KbEvalDeps): Promise<KbEvalReport> {
  const args = parseArgs(argv);
  const token = deps.env[KB_EVAL_TOKEN_ENV];
  if (token === undefined || token === '') throw new Error(`kb-eval: ${KB_EVAL_TOKEN_ENV} is not set`);

  const searchUrl = `${args.baseUrl}/api/projects/${encodeURIComponent(args.project)}/knowledge/search`;
  const answers: Record<string, KbEvalHit[]> = {};
  for (const entry of deps.questions) {
    answers[entry.id] = await ask(deps, searchUrl, token, entry);
  }

  const report = scoreRun(deps.questions, answers);
  for (const line of formatReport(report)) deps.print(line);
  if (args.out !== undefined) {
    await deps.writeFile(args.out, `${JSON.stringify(report, null, 2)}\n`);
    deps.print(`kb-eval: report written to ${args.out}`);
  }
  return report;
}

async function ask(deps: KbEvalDeps, searchUrl: string, token: string, entry: KbEvalQuestion): Promise<KbEvalHit[]> {
  let response: Response;
  try {
    response = await deps.fetch(searchUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: entry.question, limit: KB_EVAL_HIT_LIMIT }),
    });
  } catch (error) {
    deps.print(`kb-eval: ${entry.id} search request failed: ${reasonOf(error)}`);
    return [];
  }

  if (!response.ok) {
    deps.print(`kb-eval: ${entry.id} search failed with HTTP ${response.status}`);
    return [];
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    deps.print(`kb-eval: ${entry.id} search answered a non-JSON body: ${reasonOf(error)}`);
    return [];
  }

  const hits = readHits(payload);
  if (hits === null) {
    deps.print(`kb-eval: ${entry.id} search answered no hits array`);
    return [];
  }
  return hits;
}

/** The ranked hits of the Nathapp `{ret, data}` envelope, or null when the body is not a search result. */
function readHits(payload: unknown): KbEvalHit[] | null {
  const data = (payload as { data?: unknown } | null | undefined)?.data;
  const hits = (data as { hits?: unknown } | null | undefined)?.hits;
  if (!Array.isArray(hits)) return null;
  return hits.map(toHit).filter((hit): hit is KbEvalHit => hit !== null);
}

/** A hit as the script reads it; a malformed entry is dropped rather than failing the question. */
function toHit(raw: unknown): KbEvalHit | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { owner, name, path } = raw as Record<string, unknown>;
  if (typeof owner !== 'string' || typeof name !== 'string' || typeof path !== 'string') return null;
  const rawAnchor = (raw as Record<string, unknown>)['anchor'];
  // The API writes '' on the document summary chunk, which is "no anchor" (project-knowledge.controller.ts).
  return typeof rawAnchor === 'string' && rawAnchor !== ''
    ? { owner, name, path, anchor: rawAnchor }
    : { owner, name, path };
}

function parseArgs(argv: readonly string[]): KbEvalArgs {
  const found = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === undefined || !(FLAGS as readonly string[]).includes(flag)) {
      throw new Error(`kb-eval: unexpected argument ${flag ?? ''} (expected ${FLAGS.join(', ')})`);
    }
    if (value === undefined || value.startsWith('--')) throw new Error(`kb-eval: ${flag} needs a value`);
    found.set(flag, value);
  }

  const baseUrl = found.get('--base-url');
  if (baseUrl === undefined || baseUrl === '') throw new Error('kb-eval: --base-url is required');
  const project = found.get('--project');
  if (project === undefined || project === '') throw new Error('kb-eval: --project is required');
  const out = found.get('--out');
  return { baseUrl: baseUrl.replace(/\/+$/, ''), project, ...(out === undefined || out === '' ? {} : { out }) };
}

export function loadQuestions(path: string): KbEvalQuestion[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(parsed)) throw new Error(`kb-eval: ${path} must hold an array of questions`);
  return parsed as KbEvalQuestion[];
}

export async function main(argv: readonly string[]): Promise<void> {
  const questions = loadQuestions(DEFAULT_QUESTIONS_PATH);
  await runEval(argv, {
    fetch: globalThis.fetch,
    env: process.env,
    print: (line) => console.log(line),
    writeFile: (path, text) => writeFile(path, text, 'utf8'),
    questions,
  });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(reasonOf(error));
    process.exitCode = 1;
  });
}
