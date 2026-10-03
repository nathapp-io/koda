/**
 * Spec §4.3 / plan D256: parses nax's flattened approval `detail` (ask-link-session.ts:181-188, identical in v0.83.2
 * and main):
 *
 *   ```\n<command>\n```\n[N secret value(s) masked; the approved command contains them\n]request: <summary>\nruns in: <root>\nreason:  <reason>\nstage:   <stage>
 *
 * `<summary>` is `<tool> command=<command>` masked, trimmed and cut to 200 chars, so it may span lines. Any ambiguity
 * returns null: the caller then relays the raw text, never a guessed command.
 */
export interface ParsedDetail { command: string; maskedCount: number; root: string; reason: string; stage: string }

const FENCE = '```';
const FOOTER = /^(\d+) secret value\(s\) masked; the approved command contains them\n/;
const TAIL = [/^runs in: (.*)$/, /^reason:\s+(.*)$/, /^stage:\s+(.*)$/] as const;
const REQUEST = 'request: ';
/** nax cuts the summary to this many chars (tools/ask-request.ts MAX_ASK_SUMMARY_CHARS). */
const SUMMARY_MAX = 200;

export function parseDetail(detail: string): ParsedDetail | null {
  const lines = detail.split('\n');
  if (lines.length < 4) return null;
  const tail = lines.slice(-3).map((line, i) => TAIL[i].exec(line)?.[1]);
  if (tail.some((value) => value === undefined)) return null;
  const [root, reason, stage] = tail as [string, string, string];
  const head = lines.slice(0, -3).join('\n');
  if (!head.startsWith(`${FENCE}\n`)) return null;

  const separator = `\n${FENCE}\n`;
  const candidates: Array<{ command: string; maskedCount: number; summary: string }> = [];
  for (let at = head.indexOf(separator, FENCE.length); at !== -1; at = head.indexOf(separator, at + 1)) {
    let rest = head.slice(at + separator.length);
    const footer = FOOTER.exec(rest);
    if (footer) rest = rest.slice(footer[0].length);
    if (rest.startsWith(REQUEST)) {
      candidates.push({ command: head.slice(FENCE.length + 1, at), maskedCount: footer ? Number(footer[1]) : 0, summary: rest.slice(REQUEST.length) });
    }
  }
  // A command that itself contains a closing fence followed by a request line makes the layout ambiguous: never guess.
  if (candidates.length !== 1) return null;
  const { command, maskedCount, summary } = candidates[0];
  const tool = summary.split(' ', 1)[0];
  const recon = `${tool} command=${command}`;
  // Exact when nax did not cut the summary; a prefix only when it did (exactly 200 chars).
  const consistent = summary.length < SUMMARY_MAX ? recon.trim() === summary : summary.length === SUMMARY_MAX && recon.startsWith(summary);
  if (tool === '' || !consistent) return null;
  return { command, maskedCount, root, reason, stage };
}
