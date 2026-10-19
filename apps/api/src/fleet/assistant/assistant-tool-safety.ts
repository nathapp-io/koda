/**
 * Fleet S5b §1 (US-001): pure output-safety primitives shared by the API tool layer.
 *
 * The executor masks every user-written field, wraps it in a per-call fence and caps the whole result, so a
 * result the agent reads can never smuggle a credential or make fenced data look like instructions. Nothing
 * here touches the network, the database or the clock: each function is a pure string transform.
 */

const MASKED = '[masked]';
const TRUNCATED = '[truncated]';
/** U+200B: breaks the closing marker apart without changing how the text reads. */
const ZERO_WIDTH_SPACE = '\u200b';
const encoder = new TextEncoder();

/** Step 1: whole PEM blocks. Runs first, so later passes never see the base64 body. */
const PEM_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** Step 2: token shapes; the prefix is part of the match, so it is masked with the rest. */
const TOKEN_SHAPES: readonly RegExp[] = [
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /glpat-[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];

/** Step 3: an authentication scheme value, whatever shape it has. */
const BEARER = /\bBearer\s+[^\s,;]+/gi;

/** Step 4: the key names whose values are always secret. */
const SECRET_KEY = /SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE_KEY/i;

/** The characters that end an unquoted value: a whitespace, `,`, `;` or `&` (spec §1 step 4). */
const VALUE_STOP = /[\s,;&]/;
/** `\s`, the whitespace a key/value separator allows around its `:` or `=`. */
const WHITESPACE = /\s/;

/*
 * The two passes below (steps 4 and 5) are hand-written scanners rather than regular expressions. Each one has to
 * read its semantic unit — an assignment key, a URL scheme — in full, and a regular expression that does that on a
 * line-shaped result (one long word run, no separator in sight) is quadratic: the engine retries the unbounded tail
 * from every start position. Bounding the tail is not the answer either, because a bound truncates the unit and leaks
 * the credential it names: `TOKEN` + 300 word characters + `=hunter2` is one key whose secret word a 256-character
 * suffix cannot see, and `a` + 32 digits + `://user:pw@host` is a scheme that a 32-character scheme bound misses
 * entirely. A scanner reads each run once, from its start, and stays linear without any bound.
 */

const UPPER_A = 0x41;
const UPPER_Z = 0x5a;
const LOWER_A = 0x61;
const LOWER_Z = 0x7a;
const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const QUOTE = 0x22;
const UNDERSCORE = 0x5f;
const DOT = 0x2e;
const HYPHEN = 0x2d;
const PLUS = 0x2b;

const isLetter = (code: number): boolean =>
  (code >= UPPER_A && code <= UPPER_Z) || (code >= LOWER_A && code <= LOWER_Z);
const isDigit = (code: number): boolean => code >= DIGIT_0 && code <= DIGIT_9;
/** `[A-Za-z0-9_.-]`: a bare assignment key character. */
const isKeyChar = (code: number): boolean =>
  isLetter(code) || isDigit(code) || code === UNDERSCORE || code === DOT || code === HYPHEN;
/** `[A-Za-z0-9+.-]`: a URL scheme character after its first letter (`RFC 3986`). */
const isSchemeChar = (code: number): boolean =>
  isLetter(code) || isDigit(code) || code === PLUS || code === DOT || code === HYPHEN;
const isSpace = (char: string | undefined): boolean => char !== undefined && WHITESPACE.test(char);

const unquote = (key: string): string => key.replace(/^"|"$/g, '');

/** The end (exclusive) of a `"`-quoted value, `\`-escaped characters included; an unterminated one runs to the end. */
function quotedEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '"') return i + 1;
    i += 1;
  }
  return text.length;
}

/** The end (exclusive) of a `{...}` / `[...]` value, its nested strings included; an unterminated one runs to the end. */
function bracketedEnd(text: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const char = text[i];
    if (char === '"') { i = quotedEnd(text, i); continue; }
    if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return text.length;
}

/** The end (exclusive) of an unquoted value: it runs to the next whitespace, `,`, `;`, `&` or the end of the text. */
function bareEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length && !VALUE_STOP.test(text[i] as string)) i += 1;
  return i;
}

/**
 * The end (exclusive) of the value that starts at `start`, by the value's own shape (spec §1 step 4). A `{...}` /
 * `[...]` value is followed by any unquoted suffix (`[abc]hunter2`), which runs on to the next VALUE_STOP like a bare
 * value. That suffix may also swallow an enclosing closer (`{"password":{"a":1}}` masks the outer `}` too): stopping
 * at a closer would leak the suffix text after it (`[abc]hun}ter2`), so the over-mask is the safe side. A `"`-quoted
 * value is followed by its unquoted suffix too (`"abc"hunter2`), unless a JSON closer comes right after the quote.
 */
function valueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"') {
    const end = quotedEnd(text, start);
    const next = text[end];
    return next === undefined || next === '}' || next === ']' ? end : bareEnd(text, end);
  }
  if (first === '{' || first === '[') return bareEnd(text, bracketedEnd(text, start));
  return bareEnd(text, start);
}

/** A quoted value keeps its quotes; every other value is replaced whole. */
function maskValue(value: string): string {
  return value.startsWith('"') ? `"${MASKED}"` : MASKED;
}

/*
 * Step 4: every key that names a secret loses its value. One assignment is a `"`-quoted key or a bare
 * `[A-Za-z0-9_.-]+` word, then `:` or `=` (surrounded by any whitespace). A quoted key is matched up to its next `"`
 * without escape handling, exactly as the value scan used to run: that also finds an assignment written inside an
 * escaped string (`\"apiKey\":\"x\"`), at the cost of reading an escaped quote as the key's close. The quotes of a key
 * stay in place.
 *
 * The pass is a scanner rather than one replace, because a key that is not a secret must not consume its value —
 * `{"config":{"apiKey":"x"}}` still masks the nested `apiKey`.
 */

/** One assignment found by the scanner: the key `[keyStart, keyEnd)`, then its separator up to `end`. */
interface Assignment {
  readonly keyStart: number;
  readonly keyEnd: number;
  readonly end: number;
}

/** The end (exclusive) of the `\s*[:=]\s*` separator at `start`, or `-1` when the text has no separator there. */
function separatorEnd(text: string, start: number): number {
  let index = start;
  while (isSpace(text[index])) index += 1;
  if (text[index] !== ':' && text[index] !== '=') return -1;
  index += 1;
  while (isSpace(text[index])) index += 1;
  return index;
}

/**
 * The leftmost assignment at or after `from`, or `null` when the rest of the text holds none. The scan only starts a
 * bare key at the start of a maximal word run, which is what keeps it linear: a run ends at `:`, `=`, whitespace or a
 * character outside the key class, so a suffix of it fails for the same reason the whole run does and no match can
 * begin inside one.
 */
function nextAssignment(text: string, from: number): Assignment | null {
  const length = text.length;
  let index = from;
  while (index < length) {
    let keyEnd = -1;
    if (text.charCodeAt(index) === QUOTE) {
      const close = text.indexOf('"', index + 1);
      if (close !== -1) keyEnd = close + 1;
    } else if (isKeyChar(text.charCodeAt(index)) && (index === from || !isKeyChar(text.charCodeAt(index - 1)))) {
      keyEnd = index + 1;
      while (keyEnd < length && isKeyChar(text.charCodeAt(keyEnd))) keyEnd += 1;
    }
    if (keyEnd !== -1) {
      const end = separatorEnd(text, keyEnd);
      if (end !== -1) return { keyStart: index, keyEnd, end };
    }
    index += 1;
  }
  return null;
}

/**
 * Step 4 (continued): applies the scan. After a secret's value has been masked the scan resumes past it, and after
 * any other assignment it resumes right behind the separator, so a value that holds a nested assignment is still
 * scanned.
 */
function maskKeyValues(text: string): string {
  let out = '';
  let cursor = 0;
  let search = 0;
  let assignment = nextAssignment(text, search);
  while (assignment !== null) {
    const { keyStart, keyEnd, end } = assignment;
    out += text.slice(cursor, keyStart) + text.slice(keyStart, end);
    cursor = end;
    search = end;
    if (SECRET_KEY.test(unquote(text.slice(keyStart, keyEnd)))) {
      const valueStop = valueEnd(text, cursor);
      // A key with no value at all (`password: ` at the end of a line) keeps its text: there is nothing to mask.
      if (valueStop > cursor) {
        out += maskValue(text.slice(cursor, valueStop));
        cursor = valueStop;
        search = valueStop;
      }
    }
    assignment = nextAssignment(text, search);
  }
  return out + text.slice(cursor);
}

/**
 * Step 5: URL userinfo (`scheme://user:pass@host`), which the key/value pass cannot see. The scheme is the whole
 * `[A-Za-z][A-Za-z0-9+.-]*` run before `://`, whatever its length: only the run's first letter can start a match, and
 * the userinfo scan stops at the first `/`, `@` or whitespace. Every `://` carries its own `/`, so two scans never
 * read the same stretch of text — the pass is linear without bounding the scheme.
 */
function maskUrlUserinfo(text: string): string {
  const length = text.length;
  let out = '';
  let cursor = 0;
  let index = 0;
  while (index < length) {
    if (index > 0 && isSchemeChar(text.charCodeAt(index - 1))) {
      index += 1;   // already inside a scheme run, which only starts a match at its first character
      continue;
    }
    let runEnd = index;
    let holdsLetter = false;
    while (runEnd < length && isSchemeChar(text.charCodeAt(runEnd))) {
      if (isLetter(text.charCodeAt(runEnd))) holdsLetter = true;
      runEnd += 1;
    }
    if (holdsLetter && text.startsWith('://', runEnd)) {
      const at = userinfoEnd(text, runEnd + 3);
      if (at > runEnd + 3) {
        out += text.slice(cursor, runEnd + 3) + MASKED + '@';
        cursor = at + 1;
        index = at + 1;
        continue;
      }
    }
    index = runEnd > index ? runEnd : index + 1;
  }
  return out + text.slice(cursor);
}

/** The index of the `@` closing the userinfo at `start`, or `-1` when it meets `/`, another `@` or whitespace first. */
function userinfoEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length) {
    const char = text[index] as string;
    if (char === '@') return index;
    if (char === '/' || isSpace(char)) return -1;
    index += 1;
  }
  return -1;
}

/**
 * Replaces every credential-looking value with `[masked]`, in the order the spec fixes: PEM blocks, token
 * shapes, `Bearer` values, secret-named key/value pairs, then URL userinfo. Text that matches nothing is
 * returned character for character.
 */
export function maskSecrets(text: string): string {
  let out = text.replace(PEM_BLOCK, MASKED);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, MASKED);
  out = out.replace(BEARER, `Bearer ${MASKED}`);
  out = maskKeyValues(out);
  return maskUrlUserinfo(out);
}

/**
 * Wraps untrusted text in this call's data fence. Any `<<end-koda-data-` inside the text is broken apart, so
 * the text can never close its own fence and pass for instructions.
 */
export function fenceData(text: string, token: string): string {
  const escaped = text.replaceAll('<<end-koda-data-', `<<end-koda-data${ZERO_WIDTH_SPACE}-`);
  return `<<koda-data-${token}>>\n${escaped}\n<<end-koda-data-${token}>>`;
}

/** The longest whole-code-point prefix of `text` whose UTF-8 size is at most `maxBytes`. */
function cutAtBytes(text: string, maxBytes: number): string {
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = encoder.encode(char).byteLength;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return text.slice(0, end);
}

/**
 * Caps a result to `maxBytes` of UTF-8; the cap is absolute for every `maxBytes`. Text that fits is returned
 * unchanged. Otherwise the result keeps the longest run of whole leading lines that fits beside a final
 * `[truncated]` line; when not even the first line fits that way, the first line is cut at a character boundary
 * instead. A cap too small to hold the marker line itself (`maxBytes` below `1 + [truncated]`) has no room for an
 * honest marker, so it falls back to the longest character-boundary prefix of the text that fits.
 */
export function capText(text: string, maxBytes: number): string {
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  const reserve = 1 + encoder.encode(TRUNCATED).byteLength; // the newline before the marker
  if (maxBytes < reserve) return cutAtBytes(text, Math.max(0, maxBytes));
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = used + (kept.length > 0 ? 1 : 0) + encoder.encode(line).byteLength;
    if (next + reserve > maxBytes) break;
    kept.push(line);
    used = next;
  }
  if (kept.length > 0) return [...kept, TRUNCATED].join('\n');
  return `${cutAtBytes(lines[0] ?? '', maxBytes - reserve)}\n${TRUNCATED}`;
}
