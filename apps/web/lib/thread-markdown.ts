/**
 * Fleet S5a B4-D1/D6 (US-006): the one piece of runner/agent text that reaches the DOM as HTML.
 *
 * Assistant thread message `content` renders through the shared sanitizer
 * (`renderMarkdownOrEscape`) and then every `img` element is removed, so agent-steered text
 * (repo content, prompt injection) can never make the browser fetch a URL. Links stay — they
 * need a click.
 */

import { renderMarkdownOrEscape } from '~/lib/markdown'

/** Every `<img …>` element, case-insensitively, with or without a trailing slash or attributes. */
const IMG_TAG = /<img\b[^>]*>/gi

/** B4-D6: assistant content through the shared sanitizer, images stripped. */
export function renderThreadMarkdown(content: string): string {
  return renderMarkdownOrEscape(content).replace(IMG_TAG, '')
}