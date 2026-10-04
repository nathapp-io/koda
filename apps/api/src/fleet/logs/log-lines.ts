const NL = 0x0a;

/** One line (or a cut piece of one) as absolute byte offsets; `end` includes the `\n` when there is one. */
export interface LineSpan {
  start: number;
  end: number;
  /** D337: starts mid-line, or ends without `\n` before the end of a complete stream. */
  cut: boolean;
}

export interface SpanWindow {
  /** Ascending. */
  spans: LineSpan[];
  /** Where the spans begin; backward: the next cursor when no limit stopped the scan. */
  linesStart: number;
  /** Where the spans end; forward: the next cursor when no limit stopped the scan. */
  linesEnd: number;
  /** Forward: the window reached the file size. Backward: the window ended at the file size. */
  reachedEnd: boolean;
}

export interface ScanOptions {
  cursor: number;
  size: number;
  /** The FleetJobLog row says complete: the last line may lack `\n`. */
  complete: boolean;
  scanBytes: number;
}

/** Index of the next `\n` at or after absolute `from` and before absolute `to`, or -1. */
function nextNewline(buf: Buffer, bufStart: number, from: number, to: number): number {
  const i = buf.indexOf(NL, Math.max(0, from - bufStart));
  return i === -1 || i + bufStart >= to ? -1 : i + bufStart;
}

/** True when absolute offset `at` begins a line: 0, or the byte before it is `\n`. */
function startsLine(buf: Buffer, bufStart: number, at: number): boolean {
  return at === 0 || buf[at - 1 - bufStart] === NL;
}

/** Bytes forwardSpans needs: one before the cursor (line-start check) up to the scan bound. */
export function forwardReadRange(o: ScanOptions): { from: number; to: number } {
  const cursor = Math.min(o.cursor, o.size);
  return { from: Math.max(0, cursor - 1), to: Math.min(cursor + o.scanBytes, o.size) };
}

/** Spec §3.3 forward scan of `[cursor, cursor + scanBytes)` (D335-D337). */
export function forwardSpans(buf: Buffer, bufStart: number, o: ScanOptions): SpanWindow {
  const cursor = Math.min(o.cursor, o.size);
  const windowEnd = Math.min(cursor + o.scanBytes, o.size);
  const midLine = !startsLine(buf, bufStart, cursor);
  const spans: LineSpan[] = [];
  let pos = cursor;
  for (let nl = nextNewline(buf, bufStart, pos, windowEnd); nl !== -1; nl = nextNewline(buf, bufStart, pos, windowEnd)) {
    spans.push({ start: pos, end: nl + 1, cut: pos === cursor && midLine });
    pos = nl + 1;
  }
  const reachedEnd = windowEnd === o.size;
  if (pos < windowEnd && reachedEnd && o.complete) {
    spans.push({ start: pos, end: windowEnd, cut: pos === cursor && midLine });
    pos = windowEnd;
  } else if (spans.length === 0 && windowEnd > cursor && windowEnd - cursor === o.scanBytes) {
    spans.push({ start: cursor, end: windowEnd, cut: true }); // a full window with no line boundary (R12)
    pos = windowEnd;
  }
  return { spans, linesStart: cursor, linesEnd: pos, reachedEnd };
}

/** Bytes backwardSpans needs: one before the window start (line-start check) up to the cursor. */
export function backwardReadRange(o: ScanOptions): { from: number; to: number } {
  const cursor = Math.min(o.cursor, o.size);
  const windowStart = Math.max(0, cursor - o.scanBytes);
  return { from: Math.max(0, windowStart - 1), to: cursor };
}

/** Spec §3.3 backward scan of `[cursor - scanBytes, cursor)`: the leading partial line is dropped unless at 0. */
export function backwardSpans(buf: Buffer, bufStart: number, o: ScanOptions): SpanWindow {
  const cursor = Math.min(o.cursor, o.size);
  const windowStart = Math.max(0, cursor - o.scanBytes);
  const reachedEnd = cursor === o.size;
  if (cursor === windowStart) return { spans: [], linesStart: cursor, linesEnd: cursor, reachedEnd };
  const firstNl = nextNewline(buf, bufStart, windowStart, cursor);
  const first = startsLine(buf, bufStart, windowStart) ? windowStart : firstNl === -1 ? -1 : firstNl + 1;
  if (first === -1 || first >= cursor) {
    // No line starts inside the window: it is the middle or tail of an overlong line (R12).
    return { spans: [{ start: windowStart, end: cursor, cut: true }], linesStart: windowStart, linesEnd: cursor, reachedEnd };
  }
  const spans: LineSpan[] = [];
  let pos = first;
  while (pos < cursor) {
    const nl = nextNewline(buf, bufStart, pos, cursor);
    const end = nl === -1 ? cursor : nl + 1;
    const endsLine = nl !== -1 || (end === o.size && o.complete);
    spans.push({ start: pos, end, cut: !endsLine });
    pos = end;
  }
  return { spans, linesStart: first, linesEnd: cursor, reachedEnd };
}

/** D338: where a backward read without a cursor starts. `tail` holds the bytes `[tailStart, size)`. */
export function visibleEnd(tail: Buffer, tailStart: number, size: number, complete: boolean): number {
  if (complete) return size;
  const i = tail.lastIndexOf(NL);
  return i === -1 ? tailStart : tailStart + i + 1;
}
