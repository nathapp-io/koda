export const LOG_TEXT_BYTES = 8_000;
/** Leaves room under the 16,384-byte payload limit for `{"stream":"stdout","text":""}`. */
export const LOG_JSON_BYTES = 15_000;
export const LOG_PER_MINUTE = 60;

const escapedBytes = (ch: string): number => Buffer.byteLength(JSON.stringify(ch), 'utf8') - 2;

/** Splits text into chunks whose serialised JSON stays under the limit even for control characters. */
export function chunkText(text: string): string[] {
  const chunks: string[] = [];
  let current = '';
  let raw = 0;
  let json = 0;
  for (const ch of text) {
    const r = Buffer.byteLength(ch, 'utf8');
    const j = escapedBytes(ch);
    if (current !== '' && (raw + r > LOG_TEXT_BYTES || json + j > LOG_JSON_BYTES)) {
      chunks.push(current);
      current = '';
      raw = 0;
      json = 0;
    }
    current += ch;
    raw += r;
    json += j;
  }
  if (current !== '') chunks.push(current);
  return chunks;
}

/** A sliding one-minute window over log events; refusals are counted until reported (D45). */
export class LogBudget {
  private stamps: number[] = [];
  private lost = 0;

  constructor(private readonly nowMs: () => number, private readonly perMinute: number = LOG_PER_MINUTE) {}

  take(): boolean {
    const now = this.nowMs();
    this.stamps = this.stamps.filter((t) => now - t < 60_000);
    if (this.stamps.length >= this.perMinute) {
      this.lost += 1;
      return false;
    }
    this.stamps.push(now);
    return true;
  }

  get dropped(): number {
    return this.lost;
  }

  takeDropped(): number {
    const n = this.lost;
    this.lost = 0;
    return n;
  }
}
