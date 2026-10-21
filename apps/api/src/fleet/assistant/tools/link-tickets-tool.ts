import { NotFoundAppException } from '@nathapp/nestjs-common';
import type { CreateTicketLinkDto } from '../../../ticket-links/dto/create-ticket-link.dto';
import { TicketLinksService } from '../../../ticket-links/ticket-links.service';
import { TicketsService } from '../../../tickets/tickets.service';
import { maskSecrets } from '../assistant-tool-safety';
import { KODA_LINK_TICKETS } from '../koda-tool-descriptors';
import { ToolActionError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { TICKET_REF } from './ticket-tools';
import { asRecord } from './tool-input';

/**
 * Fleet S5b 2b1 US-005 (2b1-D4 to D7): `koda_link_tickets` proposes 1 to 20 URLs attached to tickets of the thread's
 * project and, once the user approves the proposal, creates them one at a time in the order given. A preview never
 * writes anything; `execute` is what an approve runs, and it stops at the first link koda cannot create, quoting the
 * lines it already wrote.
 */

/** 2b1-D5: how many links one call takes, and how long a URL may be. The descriptor carries the same numbers. */
const MAX_LINKS = 20;
const MAX_URL_CHARS = 2_048;

/** 2b1-D5: the four link kinds the parser accepts — the set `TicketLinksService.inferLinkType` can answer. */
const LINK_TYPES = ['url', 'pr', 'commit', 'branch'] as const;
export type TicketLinkType = (typeof LINK_TYPES)[number];

/** One proposed link, as the parser accepted it. The URL is kept as written. */
export interface TicketLinkInput {
  ref: string;
  url: string;
  linkType?: TicketLinkType;
}

export interface LinkTicketsInput {
  links: TicketLinkInput[];
}

const isLinkType = (value: unknown): value is TicketLinkType =>
  typeof value === 'string' && (LINK_TYPES as readonly string[]).includes(value);

/**
 * `koda_link_tickets` (2b1-D3): URLs attached to existing tickets of the thread's project. `execute` attaches them
 * through `TicketLinksService.create`, so the usual link row is written as the requester.
 */
export function linkTicketsTool(deps: {
  tickets: TicketsService;
  links: TicketLinksService;
}): AssistantTool<LinkTicketsInput> {
  return {
    descriptor: KODA_LINK_TICKETS,
    key: 'ticket.link.add',
    // 2b1-D4: the link route checks membership only (`ticket-links.controller.ts`), so this tool does too.
    permission: { kind: 'member' },
    kind: 'write',
    parse(input: unknown): LinkTicketsInput {
      const links = asRecord(input)['links'];
      if (!Array.isArray(links) || links.length < 1 || links.length > MAX_LINKS) {
        throw new ToolInputError('links');
      }
      // `i` is the zero-based index, and it names the field the refusal is about.
      return { links: links.map((link, i) => parseLink(link, i)) };
    },
    /**
     * 2b1-D6: the text the user approves — the count, the project slug and one line per link. Every named ticket is
     * read through the project-scoped `TicketsService.findByRef`, so a foreign or missing ref raises
     * `NotFoundAppException` and the executor answers `not_found` before any action exists. The `linkType` shown is
     * the one given, or the one `TicketLinksService` will infer, and the whole text is masked.
     */
    async preview(ctx: ToolContext, input: LinkTicketsInput): Promise<string> {
      const lines = [`Link ${input.links.length} URL(s) in ${ctx.projectSlug}:`];
      for (const link of input.links) {
        const ticket = await deps.tickets.findByRef(ctx.projectSlug, link.ref);
        lines.push(`- ${link.ref} "${ticket.title}" <- ${link.linkType ?? inferLinkType(link.url)} ${link.url}`);
      }
      return maskSecrets(lines.join('\n'));
    },
    /**
     * 2b1-D7: one `TicketLinksService.create` per link, in input order, as the requester with the action project's
     * role. The batch is not atomic: a failure stops it and the error quotes the lines already written (2b1-D2). A
     * URL the ticket already carries is not a failure — the service answers 200 and the batch continues.
     *
     * These lines echo the URL as given, so the answer is masked exactly as the preview is (branch review B2): it
     * becomes the action's stored `result`, the thread's outcome note and the next turn's delivery to the agent, and
     * a URL may carry a credential in its query string.
     */
    async execute(ctx: ToolContext, input: LinkTicketsInput): Promise<string> {
      const linked: string[] = [];
      for (const [i, link] of input.links.entries()) {
        let alreadyLinked: boolean;
        try {
          const created = await deps.links.create(ctx.projectSlug, link.ref, toDto(link));
          alreadyLinked = created.status === 200;
        } catch (error) {
          const reason = error instanceof NotFoundAppException ? 'not_found' : 'error';
          throw new ToolActionError(maskSecrets([...linked, `failed at link ${i + 1}: ${reason}`].join('\n')));
        }
        linked.push(`linked ${link.ref} ${link.url}${alreadyLinked ? ' (already linked)' : ''}`);
      }
      return maskSecrets(linked.join('\n'));
    },
  };
}

/** One link of the batch, judged by 2b1-D5's bounds and refused with the field's own reason. */
function parseLink(item: unknown, i: number): TicketLinkInput {
  const raw = asRecord(item);
  const ref = raw['ref'];
  if (typeof ref !== 'string' || !TICKET_REF.test(ref)) throw new ToolInputError(`links[${i}].ref`);
  const url = raw['url'];
  if (typeof url !== 'string' || !isHttpUrl(url)) throw new ToolInputError(`links[${i}].url`);
  const linkType = optionalLinkType(raw['linkType'], `links[${i}].linkType`);
  return {
    ref,
    url,
    ...(linkType === undefined ? {} : { linkType }),
  };
}

/** An absent field, or one of the four link kinds; anything else is the named refusal (2b1-D5). */
function optionalLinkType(value: unknown, reason: string): TicketLinkType | undefined {
  if (value === undefined) return undefined;
  if (!isLinkType(value)) throw new ToolInputError(reason);
  return value;
}

/**
 * 2b1-D5: an absolute `http:` or `https:` URL of at most 2048 characters after trim. Only the trimmed length is
 * judged; the value itself is stored as written.
 */
function isHttpUrl(value: string): boolean {
  if (!withinChars(value, 1, MAX_URL_CHARS)) return false;
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** 2b1-D5: the trimmed length is what is judged; the value itself is stored as written. */
const withinChars = (text: string, min: number, max: number): boolean => {
  const length = text.trim().length;
  return length >= min && length <= max;
};

/**
 * 2b1-D6: the kind `TicketLinksService.inferLinkType` gives a URL when the caller gave none, copied here because
 * that method is private: `pr` for a forge pull request URL, else `url`. What the preview shows is what the service
 * will store.
 */
function inferLinkType(url: string): TicketLinkType {
  if (/\/pull\/\d+/.test(url) || /\/merge_requests\/\d+/.test(url) || /\/pull-requests\/\d+/.test(url)) return 'pr';
  return 'url';
}

/** What the service takes: the parsed URL and kind, or the URL alone so the service infers the kind (2b1-D7). */
function toDto(link: TicketLinkInput): CreateTicketLinkDto {
  return {
    url: link.url,
    ...(link.linkType === undefined ? {} : { linkType: link.linkType }),
  };
}
