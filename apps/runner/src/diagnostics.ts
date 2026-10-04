import { open } from 'node:fs/promises';

const MAX_DIAGNOSTIC = 800;
const TAIL_BYTES = 16_384;
const SECRET_NAME = /token|secret|password|api[_-]?key|authorization/i;

/** Free text needs value redaction too: Logger.redact only handles structured field names. */
export function sanitizeDiagnostic(text: string, env: Readonly<Record<string, string | undefined>> = process.env): string {
  let clean = text
    // eslint-disable-next-line no-control-regex -- Normalize terminal formatting before matching secret values.
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex -- Remove controls before matching values split by nonprinting bytes.
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  const secrets = Object.entries(env).filter(([key, value]) => SECRET_NAME.test(key) && value && value.length >= 4)
    .map(([, value]) => value as string).sort((a, b) => b.length - a.length);
  for (const secret of secrets) clean = clean.split(secret).join('[redacted]');
  return clean
    .replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1[redacted]@')
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/\b((?:[A-Za-z0-9_-]*(?:token|secret|password|api[_-]?key)[A-Za-z0-9_-]*|authorization)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)/gi, '$1[redacted]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+|(?:bot)?\d{6,12}:[A-Za-z0-9_-]{20,})\b/g, '[redacted]')
    .trim().slice(0, MAX_DIAGNOSTIC);
}

/** Bounded I/O even for huge stderr files; diagnostic reads must never change a job's verdict. */
export async function readDiagnosticTail(path: string): Promise<string | null> {
  try {
    const file = await open(path, 'r');
    try {
      const info = await file.stat();
      if (!info.isFile()) return null;
      const start = Math.max(0, info.size - TAIL_BYTES);
      const buffer = Buffer.alloc(Math.min(info.size, TAIL_BYTES));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      const complete = start > 0 ? text.slice(text.indexOf('\n') + 1) : text;
      const lines = complete.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-5);
      return sanitizeDiagnostic(lines.join('\n')) || null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}
