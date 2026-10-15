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
/**
 * One assignment: a `"`-quoted key or a bare `[A-Za-z0-9_.-]+` word, then `:` or `=`. A quoted key is matched up to
 * its next `"` without escape handling, exactly as the value scan used to run: that also finds an assignment written
 * inside an escaped string (`\"apiKey\":\"x\"`), at the cost of reading an escaped quote as the key's close. The pass
 * is a scanner rather than one replace, because a key that is not a secret must not consume its value —
 * `{"config":{"apiKey":"x"}}` still masks the nested `apiKey`. The quotes of a key stay in place.
 */
const ASSIGNMENT = /("[^"]*"|[A-Za-z0-9_.-]+)(\s*[:=]\s*)/;

/** Step 5: URL userinfo (`scheme://user:pass@host`), which the key/value pass cannot see. */
const URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/g;

/** The characters that end an unquoted value: a whitespace, `,`, `;` or `&` (spec §1 step 4). */
const VALUE_STOP = /[\s,;&]/;

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

/** The end (exclusive) of the value that starts at `start`, by the value's own shape (spec §1 step 4). */
function valueEnd(text: string, start: number): number {
  const first = text[start];
  if (first === '"') return quotedEnd(text, start);
  if (first === '{' || first === '[') return bracketedEnd(text, start);
  return bareEnd(text, start);
}

/** A quoted value keeps its quotes; every other value is replaced whole. */
function maskValue(value: string): string {
  return value.startsWith('"') ? `"${MASKED}"` : MASKED;
}

/**
 * Step 4: every key that names a secret loses its value. The scan moves left to right; after a secret's value has
 * been masked the scan resumes past it, and after any other assignment it resumes right behind the separator, so a
 * value that holds a nested assignment (`{"config":{"apiKey":"x"}}`) is still scanned.
 */
function maskKeyValues(text: string): string {
  const pattern = new RegExp(ASSIGNMENT.source, 'g');
  let out = '';
  let cursor = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    const start = match.index;
    if (start < cursor) {
      pattern.lastIndex = cursor;   // already inside a masked value: never match there again
    } else {
      const key = match[1] as string;
      const separator = match[2] as string;
      out += text.slice(cursor, start) + key + separator;
      cursor = start + match[0].length;
      if (SECRET_KEY.test(unquote(key))) {
        const end = valueEnd(text, cursor);
        // A key with no value at all (`password: ` at the end of a line) keeps its text: there is nothing to mask.
        if (end > cursor) {
          out += maskValue(text.slice(cursor, end));
          cursor = end;
        }
      }
    }
    match = pattern.exec(text);
  }
  return out + text.slice(cursor);
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
  return out.replace(URL_USERINFO, `$1${MASKED}@`);
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
