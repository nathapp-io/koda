import { CONFIG_RESULT_LIMITS, type ConfigJobOutcome, type ConfigJobResult } from '@nathapp/fleet-protocol';
import { byteLength } from '../../sync/batch';

/** D491: leaves room in the 16 KiB snapshot payload for the result fields and the heartbeat. */
export const CONFIG_RESULT_BUDGET_BYTES = 12_288;

/** The last `maxBytes` bytes of `text`, starting on a character boundary. */
export function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) return text;
  let start = buf.byteLength - maxBytes;
  while (start < buf.byteLength && ((buf[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return buf.subarray(start).toString('utf8');
}

const build = (outcome: ConfigJobOutcome, files: string[] | undefined, output: string | undefined): ConfigJobResult => ({
  outcome, ...(files !== undefined ? { files } : {}), ...(output ? { output } : {}),
});

/** D491: the protocol caps first, then the output tail halves and trailing files drop until the result fits. */
export function fitConfigResult(result: ConfigJobResult): ConfigJobResult {
  const files = result.files?.filter((file) => file.length <= CONFIG_RESULT_LIMITS.maxFileChars).slice(0, CONFIG_RESULT_LIMITS.maxFiles);
  let fitted = build(result.outcome, files, result.output === undefined ? undefined : tailBytes(result.output, CONFIG_RESULT_LIMITS.maxOutputBytes));
  while (byteLength(fitted) > CONFIG_RESULT_BUDGET_BYTES) {
    if (fitted.output) fitted = build(fitted.outcome, fitted.files, tailBytes(fitted.output, Math.floor(Buffer.byteLength(fitted.output) / 2)));
    else if (fitted.files && fitted.files.length > 0) fitted = build(fitted.outcome, fitted.files.slice(0, -1), undefined);
    else break;
  }
  return fitted;
}
