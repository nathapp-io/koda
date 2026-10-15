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
 * `KEY=value`, `KEY: value` and JSON `"KEY": "value"`. The quotes of a quoted key or value stay in place; an
 * unquoted value runs to the next whitespace, `,`, `;`, `&` or the end of the text.
 */
const KEY_VALUE = /("[^"]*"|[A-Za-z0-9_.-]+)(\s*[:=]\s*)("[^"]+"|[^\s,;&]+)/g;

/** Step 5: URL userinfo (`scheme://user:pass@host`), which the key/value pass cannot see. */
const URL_USERINFO = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]+@/g;

const unquote = (key: string): string => key.replace(/^"|"$/g, '');

/**
 * Replaces every credential-looking value with `[masked]`, in the order the spec fixes: PEM blocks, token
 * shapes, `Bearer` values, secret-named key/value pairs, then URL userinfo. Text that matches nothing is
 * returned character for character.
 */
export function maskSecrets(text: string): string {
  let out = text.replace(PEM_BLOCK, MASKED);
  for (const shape of TOKEN_SHAPES) out = out.replace(shape, MASKED);
  out = out.replace(BEARER, `Bearer ${MASKED}`);
  out = out.replace(KEY_VALUE, (match, key: string, separator: string, value: string) =>
    SECRET_KEY.test(unquote(key)) ? `${key}${separator}${value.startsWith('"') ? `"${MASKED}"` : MASKED}` : match,
  );
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
 * Caps a result to `maxBytes` of UTF-8. Text that fits is returned unchanged. Otherwise the result keeps the
 * longest run of whole leading lines that fits beside a final `[truncated]` line; when not even the first line
 * fits that way, the first line is cut at a character boundary instead. The result never exceeds `maxBytes`.
 */
export function capText(text: string, maxBytes: number): string {
  if (encoder.encode(text).byteLength <= maxBytes) return text;
  const lines = text.split('\n');
  const reserve = 1 + encoder.encode(TRUNCATED).byteLength; // the newline before the marker
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const next = used + (kept.length > 0 ? 1 : 0) + encoder.encode(line).byteLength;
    if (next + reserve > maxBytes) break;
    kept.push(line);
    used = next;
  }
  if (kept.length > 0) return [...kept, TRUNCATED].join('\n');
  return `${cutAtBytes(lines[0] ?? '', Math.max(0, maxBytes - reserve))}\n${TRUNCATED}`;
}
