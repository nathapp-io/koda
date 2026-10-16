/**
 * Fleet S5b knowledge index (1c-c-D8): the deterministic Markdown heading chunker.
 *
 * Pure text in, chunks out — no Nest provider, no model, no clock. The caller decodes the forge file
 * (invalid bytes become U+FFFD) and this module normalises `\r\n` to `\n` before anything else.
 */

export interface MarkdownChunkInput {
  path: string;
  text: string;
}

export interface MarkdownChunk {
  chunkIndex: number;
  title: string;
  headingPath: string;
  anchor: string;
  abstract: string;
  text: string;
  status?: string;
  supersededBy?: string;
}

/** 1c-c-D8 rule 4: a section this short merges into a neighbour instead of becoming a chunk. */
const SHORT_SECTION_CHARS = 200;
/** 1c-c-D8 rule 5: a section over this many characters splits at blank lines. */
const MAX_CHUNK_CHARS = 2_000;
/** 1c-c-D8 rule 7: cap of the extractive abstract. */
const MAX_ABSTRACT_CHARS = 300;
/** The heading path the parser gives the text before the first heading; the document title replaces it. */
const PRE_HEADING = '\u0000pre-heading';

const FRONT_MATTER_DELIMITER = /^[ \t]*---[ \t]*$/;
const FRONT_MATTER_KEY = /^\s*([A-Za-z0-9_-]+)\s*:\s*(.*)$/;
const ATX_HEADING = /^(#{1,3})[ \t]+(.*)$/;
const CLOSING_HASHES = /[ \t]*#+[ \t]*$/;
const LIST_MARKER = /^\s*(?:[-*+]|\d{1,3}[.)])\s+/;
const ANCHOR_DROPPED = /[^a-z0-9 _-]/g;
const ANCHOR_SPACE = / /g;

interface FrontMatter {
  title?: string;
  status?: string;
  description?: string;
  supersededBy?: string;
}

interface Heading {
  level: number;
  text: string;
}

interface Section {
  headingPath: string;
  anchor: string;
  text: string;
}

interface ParsedDocument {
  sections: Section[];
  h2Titles: string[];
  firstH1: string | null;
}

const FRONT_MATTER_FIELDS: Readonly<Record<string, keyof FrontMatter>> = {
  title: 'title',
  status: 'status',
  description: 'description',
  'superseded-by': 'supersededBy',
};

/**
 * The document's chunks: index 0 is the summary, then one chunk per section (merged, then split).
 * Every chunk carries the file title and the front matter status, and the optional keys are absent
 * — not `undefined` — when the front matter has no such key.
 */
export function chunkMarkdown(input: MarkdownChunkInput): MarkdownChunk[] {
  const normalized = input.text.replace(/\r\n/g, '\n');
  const { frontMatter, body } = splitFrontMatter(normalized);
  const parsed = parseDocument(body.split('\n'));
  const title = frontMatter.title ?? parsed.firstH1 ?? fileName(input.path);
  // Rule 3: text before the first heading is a section whose heading path is the title.
  const sections = parsed.sections.map((section) => (section.headingPath === PRE_HEADING ? { ...section, headingPath: title } : section));
  const summary = buildSummary(title, frontMatter.description, sections, parsed.h2Titles);
  const chunks: MarkdownChunk[] = [
    { chunkIndex: 0, title, headingPath: '', anchor: '', abstract: abstractOf(summary), text: summary },
  ];
  let chunkIndex = 1;
  for (const part of splitSections(mergeSections(sections))) {
    chunks.push({
      chunkIndex: chunkIndex++,
      title,
      headingPath: part.headingPath,
      anchor: part.anchor,
      abstract: abstractOf(part.text),
      text: part.text,
    });
  }
  return chunks.map((chunk) => withStatus(chunk, frontMatter));
}

function withStatus(chunk: MarkdownChunk, frontMatter: FrontMatter): MarkdownChunk {
  const status = frontMatter.status;
  const supersededBy = frontMatter.supersededBy;
  if (status === undefined && supersededBy === undefined) return chunk;
  return {
    ...chunk,
    ...(status === undefined ? {} : { status }),
    ...(supersededBy === undefined ? {} : { supersededBy }),
  };
}

/** Rule 1: a leading `---` block with a closing `---` line; without the closing line it is ordinary text. */
function splitFrontMatter(text: string): { frontMatter: FrontMatter; body: string } {
  const lines = text.split('\n');
  if (!FRONT_MATTER_DELIMITER.test(lines[0] ?? '')) return { frontMatter: {}, body: text };
  const end = lines.findIndex((line, index) => index > 0 && FRONT_MATTER_DELIMITER.test(line));
  if (end === -1) return { frontMatter: {}, body: text };
  return { frontMatter: readFrontMatter(lines.slice(1, end)), body: lines.slice(end + 1).join('\n') };
}

function readFrontMatter(lines: string[]): FrontMatter {
  const frontMatter: FrontMatter = {};
  for (const line of lines) {
    const match = FRONT_MATTER_KEY.exec(line);
    if (!match) continue;
    const field = FRONT_MATTER_FIELDS[match[1].toLowerCase()];
    const value = match[2].trim();
    if (field === undefined || value === '') continue;
    frontMatter[field] = value;
  }
  return frontMatter;
}

/** Rule 3: ATX headings of level 1 to 3 outside fenced blocks start sections. */
function parseDocument(lines: string[]): ParsedDocument {
  const sections: Section[] = [];
  const h2Titles: string[] = [];
  const stack: Array<{ level: number; text: string }> = [];
  const anchorCounts = new Map<string, number>();
  const usedAnchors = new Set<string>();
  let firstH1: string | null = null;
  let currentLines: string[] = [];
  let currentHeading: { headingPath: string; anchor: string } | null = null;

  const flush = (): void => {
    const text = currentLines.join('\n').trim();
    currentLines = [];
    if (text === '') return;
    sections.push(currentHeading === null
      ? { headingPath: PRE_HEADING, anchor: '', text }
      : { headingPath: currentHeading.headingPath, anchor: currentHeading.anchor, text });
    currentHeading = null;
  };

  forEachContentLine(lines, (line, heading) => {
    if (heading === null) {
      currentLines.push(line);
      return;
    }
    flush();
    // A bare `#` carries no title text, so the file name stays the fallback.
    if (heading.level === 1 && firstH1 === null && heading.text !== '') firstH1 = heading.text;
    if (heading.level === 2) h2Titles.push(heading.text);
    while (stack.length > 0 && stack[stack.length - 1].level >= heading.level) stack.pop();
    stack.push({ level: heading.level, text: heading.text });
    currentHeading = {
      headingPath: stack.map((entry) => entry.text).join(' > '),
      anchor: uniqueAnchor(slug(heading.text), anchorCounts, usedAnchors),
    };
    currentLines = [line];
  });
  flush();
  return { sections, h2Titles, firstH1 };
}

/** Visits every line, with the heading it carries (`null` inside a fenced block, fences included). */
function forEachContentLine(lines: string[], visit: (line: string, heading: Heading | null) => void): void {
  let fence: string | null = null;
  for (const line of lines) {
    const marker = fenceMarker(line);
    if (fence !== null) {
      visit(line, null);
      if (marker === fence) fence = null;
      continue;
    }
    if (marker !== null) {
      fence = marker;
      visit(line, null);
      continue;
    }
    visit(line, headingOf(line));
  }
}

/** A fence opens and closes on a line starting with three backticks or three tildes. */
function fenceMarker(line: string): string | null {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('```')) return '```';
  if (trimmed.startsWith('~~~')) return '~~~';
  return null;
}

function headingOf(line: string): Heading | null {
  const match = ATX_HEADING.exec(line);
  if (!match) return null;
  return { level: match[1].length, text: match[2].replace(CLOSING_HASHES, '').trim() };
}

function isHeadingLine(line: string): boolean {
  return headingOf(line) !== null;
}

/** Rule 8: GitHub's heading ids restricted to ASCII, with a `-n` suffix on a repeated anchor. */
function slug(text: string): string {
  return text.toLowerCase().replace(ANCHOR_DROPPED, '').replace(ANCHOR_SPACE, '-');
}

function uniqueAnchor(base: string, counts: Map<string, number>, used: Set<string>): string {
  if (!used.has(base)) {
    counts.set(base, 0);
    used.add(base);
    return base;
  }
  let count = (counts.get(base) ?? 0) + 1;
  while (used.has(`${base}-${count}`)) count += 1;
  counts.set(base, count);
  used.add(`${base}-${count}`);
  return `${base}-${count}`;
}

/**
 * Rule 4: a section of fewer than 200 characters merges into the following one (its text first, the
 * following section's heading path and anchor kept); a short last section merges into the previous
 * one, which keeps its own heading path and anchor. A merged section is re-checked, so a run of
 * short sections collapses forward one neighbour at a time.
 */
function mergeSections(sections: Section[]): Section[] {
  const merged = sections.map((section) => ({ ...section }));
  let index = 0;
  while (index < merged.length) {
    const section = merged[index];
    const next = merged[index + 1];
    if (section.text.length >= SHORT_SECTION_CHARS || next === undefined) {
      index += 1;
      continue;
    }
    next.text = `${section.text}\n\n${next.text}`;
    merged.splice(index, 1);
  }
  const last = merged[merged.length - 1];
  const previous = merged[merged.length - 2];
  if (last !== undefined && previous !== undefined && last.text.length < SHORT_SECTION_CHARS) {
    previous.text = `${previous.text}\n\n${last.text}`;
    merged.pop();
  }
  return merged;
}

/** Rule 5: a section over 2000 characters splits at blank lines outside fences. */
function splitSections(sections: Section[]): Section[] {
  const parts: Section[] = [];
  for (const section of sections) {
    if (section.text.length <= MAX_CHUNK_CHARS) {
      parts.push(section);
      continue;
    }
    for (const text of splitText(section.text)) parts.push({ ...section, text });
  }
  return parts;
}

function splitText(text: string): string[] {
  const blocks = glueHeadingBlock(textBlocks(text));
  const parts: string[] = [];
  for (const block of blocks) {
    const current = parts[parts.length - 1];
    // A paragraph longer than the cap is its own part, so it is taken even when the part is open.
    if (current === undefined || current.length + 2 + block.length > MAX_CHUNK_CHARS) {
      parts.push(block);
      continue;
    }
    parts[parts.length - 1] = `${current}\n\n${block}`;
  }
  return parts;
}

/** Paragraphs of a section: blank lines outside a fence separate them, fence bodies stay together. */
function textBlocks(text: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | null = null;
  const flush = (): void => {
    if (current.length > 0) blocks.push(current.join('\n'));
    current = [];
  };
  for (const line of text.split('\n')) {
    const marker = fenceMarker(line);
    if (fence !== null) {
      current.push(line);
      if (marker === fence) fence = null;
      continue;
    }
    if (marker !== null) {
      fence = marker;
      current.push(line);
      continue;
    }
    if (line.trim() === '') {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

/**
 * A section starting with a lone heading line keeps that heading glued to the paragraph below it,
 * so an oversized first paragraph does not leave a chunk holding nothing but the heading.
 */
function glueHeadingBlock(blocks: string[]): string[] {
  const [first, second] = blocks;
  if (first === undefined || second === undefined || first.includes('\n') || !isHeadingLine(first)) return blocks;
  return [`${first}\n\n${second}`, ...blocks.slice(2)];
}

/** Rule 6: the document summary — title, description (or the first paragraph) and the H2 titles. */
function buildSummary(title: string, description: string | undefined, sections: Section[], h2Titles: string[]): string {
  const parts = [title];
  const intro = description ?? firstParagraph(sections[0]);
  if (intro !== '') parts.push(intro);
  parts.push(`Sections: ${h2Titles.join('; ')}`);
  return parts.join('\n');
}

/** The first paragraph of the section: its heading line and leading blank lines skipped. */
function firstParagraph(section: Section | undefined): string {
  if (section === undefined) return '';
  for (const block of textBlocks(section.text)) {
    const lines = block.split('\n');
    if (isHeadingLine(lines[0])) lines.shift();
    if (lines.length === 0) continue;
    if (fenceMarker(lines[0]) !== null) continue;
    return lines.join('\n').trim();
  }
  return '';
}

/**
 * Rule 7: the first two sentences of the chunk text — heading lines, fenced blocks and list markers
 * removed first — cut to 300 characters. A sentence ends at `. `, `? `, `! ` or a line break.
 */
function abstractOf(text: string): string {
  const cleaned = stripForAbstract(text);
  if (cleaned === '') return '';
  return firstTwoSentences(cleaned).slice(0, MAX_ABSTRACT_CHARS).trim();
}

function stripForAbstract(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split('\n')) {
    const marker = fenceMarker(line);
    if (fence !== null) {
      if (marker === fence) fence = null;
      continue;
    }
    if (marker !== null) {
      fence = marker;
      continue;
    }
    if (isHeadingLine(line)) continue;
    kept.push(line.replace(LIST_MARKER, ''));
  }
  return kept.join('\n').trim();
}

function firstTwoSentences(text: string): string {
  const sentences: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length && sentences.length < 2; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    const endsSentence = char === '\n'
      || ((char === '.' || char === '?' || char === '!') && (next === undefined || next === ' ' || next === '\n'));
    if (!endsSentence) continue;
    pushSentence(sentences, text.slice(start, char === '\n' ? index : index + 1));
    start = char === '\n' ? index + 1 : (next === ' ' ? index + 2 : index + 1);
    index = start - 1;
  }
  if (sentences.length < 2) pushSentence(sentences, text.slice(start));
  return sentences.join(' ');
}

function pushSentence(sentences: string[], candidate: string): void {
  const sentence = candidate.trim();
  if (sentence !== '') sentences.push(sentence);
}

function fileName(path: string): string {
  const name = path.split('/').pop() ?? path;
  return name.endsWith('.md') ? name.slice(0, -'.md'.length) : name;
}
