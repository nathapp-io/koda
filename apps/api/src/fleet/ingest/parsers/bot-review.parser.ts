import type { BundleFile, BundleFiles } from '../bundle-reader';
import { obj, parseJson } from './fields';

export interface WithdrawnEvent {
  key: string;
  threadId: string;
  file?: string;
  line?: number;
  finding: string;
  reason: string;
  disagreedBy: string[];
}

export type BotReviewParse =
  | { outcome: 'absent' }
  | { outcome: 'invalid'; reason: 'artifact-ambiguous' | 'artifact-invalid' }
  | { outcome: 'done'; trusted: boolean; events: WithdrawnEvent[] };

const KEY = /^f-[0-9a-f]{8,64}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\[bot\])?$/;
const ARTIFACT = /bot\/pr-[1-9]\d*\/[^/]+\/bot-review\.json$/;
const clean = (value: string) => value.replace(/\p{Cc}/gu, ' ').slice(0, 1000);

function parseEvent(value: unknown): WithdrawnEvent | null {
  const event = obj(value);
  if (!event || event.type !== 'finding-withdrawn' || typeof event.key !== 'string' || !KEY.test(event.key)
    || typeof event.threadId !== 'string' || event.threadId.length < 1 || event.threadId.length > 200
    || typeof event.finding !== 'string' || typeof event.reason !== 'string' || !Array.isArray(event.disagreedBy)
    || !event.disagreedBy.every((login) => typeof login === 'string')) return null;
  const disagreedBy = (event.disagreedBy as string[]).filter((login) => LOGIN.test(login)).slice(0, 10);
  const parsed: WithdrawnEvent = {
    key: event.key,
    threadId: event.threadId,
    finding: clean(event.finding),
    reason: clean(event.reason),
    disagreedBy,
  };
  if (typeof event.file === 'string') parsed.file = event.file;
  if (typeof event.line === 'number' && Number.isInteger(event.line) && event.line > 0) parsed.line = event.line;
  return parsed;
}

function selectArtifact(files: BundleFiles): BundleFile | null | undefined {
  const artifacts = files.botReview ?? [];
  if (artifacts.length === 0) return null;
  const lines = files.naxStdout?.text.split(/\r?\n/) ?? [];
  for (const line of lines) {
    const match = /^nax bot review: artifact (.+)$/.exec(line);
    if (!match) continue;
    const suffix = ARTIFACT.exec(match[1]);
    if (!suffix) return undefined;
    const selected = artifacts.filter((file) => ARTIFACT.test(file.name) && file.name.endsWith(suffix[0]));
    return selected.length === 1 ? selected[0] : undefined;
  }
  return artifacts.length === 1 ? artifacts[0] : undefined;
}

export function parseBotReview(files: BundleFiles, prNumber: number): BotReviewParse {
  const selected = selectArtifact(files);
  if (selected === null) return { outcome: 'absent' };
  if (!selected) return { outcome: 'invalid', reason: 'artifact-ambiguous' };
  const root = obj(parseJson(selected.text));
  const pr = root ? obj(root.pr) : null;
  if (!root || ![1, 2, 3].includes(root.version as number) || !pr || pr.number !== prNumber || typeof root.trusted !== 'boolean') {
    return { outcome: 'invalid', reason: 'artifact-invalid' };
  }
  const rawEvents = root.events === undefined ? [] : root.events;
  if (!Array.isArray(rawEvents)) return { outcome: 'invalid', reason: 'artifact-invalid' };
  const events: WithdrawnEvent[] = [];
  for (const raw of rawEvents) {
    const event = parseEvent(raw);
    if (event) events.push(event);
    if (events.length === 50) break;
  }
  return { outcome: 'done', trusted: root.trusted, events };
}
