/**
 * Branch review B1 / US-006 AC-8: HTML whose *quoted attribute value* holds a `>` and a tag-like
 * string. isomorphic-dompurify 2.36.0 (the production sanitizer) returns these bytes unchanged:
 * an attribute value is data, and the sanitizer escapes `&` and `"` inside it but never `<`/`>`.
 *
 * Two specs use them, and neither can run the production sanitizer itself — jest's CommonJS
 * runtime cannot load `isomorphic-dompurify` (jsdom → ESM-only `@exodus/bytes`), so
 * `tests/lib/thread-markdown.spec.ts` replaces it with a double. That is why the bytes live here
 * as one shared fixture:
 *
 * - the jest spec feeds them to the module through the double (the linkifier's own behaviour), and
 * - `tests/harness/thread-markdown-real-sanitizer.ts` (run by `bun run test`) feeds the very same
 *   bytes to the real marked + isomorphic-dompurify stack and asserts, with a real HTML parser,
 *   that the sanitizer really returns them and that nothing in them becomes markup.
 *
 * A sanitizer upgrade that changes these bytes therefore fails the harness first, in the one place
 * the claim "the double is faithful" can actually be checked.
 */

/** A path that sits in an attribute value, with a tag-like string beside it in that value. */
export const B1_QUOTED_ATTRIBUTE_HTML =
  '<span title="> /sandbox/tickets/SB-3 <svg onload=alert(1)>">hello</span>'

/** The same `>`-in-attribute shape, with the path in a real text node of the element. */
export const B1_QUOTED_ATTRIBUTE_TEXT_NODE_HTML =
  '<span title="a > b <svg onload=alert(1)>">see /sandbox/tickets/SB-3 now</span>'
