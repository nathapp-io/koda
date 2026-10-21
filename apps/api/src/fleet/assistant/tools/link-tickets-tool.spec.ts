import { NotFoundAppException } from '@nathapp/nestjs-common';
import { CreateTicketLinkDto } from '../../../ticket-links/dto/create-ticket-link.dto';
import type { TicketLinkResponseDto } from '../../../ticket-links/dto/ticket-link-response.dto';
import { TicketLinksService, type CreateTicketLinkResult } from '../../../ticket-links/ticket-links.service';
import { TicketsService } from '../../../tickets/tickets.service';
import { ToolActionError, ToolInputError, type AssistantTool, type ToolContext } from '../assistant-tool.types';
import { KODA_LINK_TICKETS } from '../koda-tool-descriptors';
import { linkTicketsTool, type LinkTicketsInput } from './link-tickets-tool';

/**
 * Fleet S5b 2b1 US-005: the ticket link tool's parser, its masked project-scoped preview and its serial,
 * idempotent execution. The tool is pure over its two collaborators here — the DB-backed path (route, propose,
 * approve, the link really stored) is `test/integration/fleet/assistant-link-tickets-tool.integration.spec.ts`.
 */

const ctx = {
  projectId: 'project-1',
  projectSlug: 'web',
  actor: { id: 'dev-1', actorType: 'user', email: 'dev@koda.test', projectRole: 'DEVELOPER' },
  threadId: 'thread-1',
  jobId: 'job-1',
  now: new Date('2026-10-23T09:00:00.000Z'),
  data: (text: string) => text,
} as unknown as ToolContext;

/** The ticket `TicketsService.findByRef` answers for `KODA-1`, as the preview reads it. */
const TICKET = { ref: 'KODA-1', title: 'Fix login' };

const PR_URL = 'https://github.com/o/r/pull/7';
const PLAIN_URL = 'https://x.dev/a';

/** The token a preview must never show: a GitHub PAT shape (`ghp_` plus 36 alphanumerics). */
const TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';

const LINK = {} as TicketLinkResponseDto;

type CreateArgs = [string, string, CreateTicketLinkDto];

/** The tool over its two collaborators; `ticket` overrides the fields `findByRef` answers. */
function toolDeps(overrides: { ticket?: Record<string, unknown> } = {}) {
  const findByRef = vi.fn(async () => ({ ...TICKET, ...overrides.ticket }));
  const create = vi.fn(async (..._args: CreateArgs): Promise<CreateTicketLinkResult> => ({ status: 201, link: LINK }));
  const tickets = { findByRef } as unknown as TicketsService;
  const links = { create } as unknown as TicketLinksService;
  return { findByRef, create, tool: linkTicketsTool({ tickets, links }) };
}

/** The `reason` a parser refuses with; fails loudly when it accepts or throws something else. */
function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolInputError);
    return (error as ToolInputError).reason;
  }
  throw new Error('expected the parser to refuse this input');
}

/** The error a call throws; fails loudly when it answers instead. */
async function failureOf(run: () => Promise<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to refuse');
}

/** The tool's preview; fails loudly when a write tool declares none. */
function previewOf(tool: AssistantTool<LinkTicketsInput>, input: LinkTicketsInput): Promise<string> {
  const preview = tool.preview;
  if (!preview) throw new Error('koda_link_tickets declares no preview');
  return preview(ctx, input);
}

/** `valid` links that differ only in their ref, so a bound test can build a batch of any size. */
const manyLinks = (count: number): unknown[] => Array.from({ length: count }, (_unused, i) => ({
  ref: `KODA-${i + 1}`,
  url: `https://x.dev/${i + 1}`,
}));

describe('koda_link_tickets parse (US-005)', () => {
  it('AC-1: an empty links array refuses with reason links', () => {
    expect(reasonOf(() => toolDeps().tool.parse({ links: [] }))).toBe('links');
  });

  it('AC-2: 21 valid links refuse with reason links, and 20 are accepted', () => {
    const tool = toolDeps().tool;

    expect(reasonOf(() => tool.parse({ links: manyLinks(21) }))).toBe('links');
    expect(tool.parse({ links: manyLinks(20) }).links).toHaveLength(20);
  });

  it('refuses links that are missing or not an array', () => {
    const tool = toolDeps().tool;
    expect(reasonOf(() => tool.parse({}))).toBe('links');
    expect(reasonOf(() => tool.parse({ links: {} }))).toBe('links');
    expect(reasonOf(() => tool.parse(null))).toBe('links');
  });

  it('AC-3: a non-http url refuses with the field\'s own index, and only http and https are accepted', () => {
    const tool = toolDeps().tool;

    expect(reasonOf(() => tool.parse({ links: [{ ref: 'KODA-1', url: 'ftp://host/x' }] }))).toBe('links[0].url');
    expect(reasonOf(() => tool.parse({ links: [{ ref: 'KODA-1', url: 7 }] }))).toBe('links[0].url');
    expect(reasonOf(() => tool.parse({ links: [{ ref: 'KODA-1', url: 'https://' }] }))).toBe('links[0].url');
    expect(reasonOf(() => tool.parse({ links: [{ ref: 'KODA-1', url: '   ' }] }))).toBe('links[0].url');
    expect(tool.parse({ links: [{ ref: 'KODA-1', url: 'http://x.dev/a' }] }).links[0]?.url).toBe('http://x.dev/a');
    expect(tool.parse({ links: [{ ref: 'KODA-1', url: PR_URL }] }).links[0]?.url).toBe(PR_URL);
  });

  it('refuses a url over 2048 characters after trim, and keeps the value as written', () => {
    const tool = toolDeps().tool;
    const base = 'https://x.dev/';
    const longest = `${base}${'a'.repeat(2_048 - base.length)}`;

    expect(reasonOf(() => tool.parse({ links: [{ ref: 'KODA-1', url: `${longest}a` }] }))).toBe('links[0].url');
    expect(tool.parse({ links: [{ ref: 'KODA-1', url: longest }] }).links[0]?.url).toBe(longest);
    expect(tool.parse({ links: [{ ref: 'KODA-1', url: `  ${PLAIN_URL}  ` }] }).links[0]?.url).toBe(`  ${PLAIN_URL}  `);
  });

  it('AC-4: a linkType outside the four refuses with the field\'s own index, and the given one is kept', () => {
    const tool = toolDeps().tool;

    expect(reasonOf(() => tool.parse({ links: [{ ref: 'KODA-1', url: PLAIN_URL, linkType: 'issue' }] })))
      .toBe('links[0].linkType');
    expect(reasonOf(() => tool.parse({ links: [{ ref: 'KODA-1', url: PLAIN_URL, linkType: 7 }] })))
      .toBe('links[0].linkType');
    for (const linkType of ['url', 'pr', 'commit', 'branch']) {
      expect(tool.parse({ links: [{ ref: 'KODA-1', url: PLAIN_URL, linkType }] }).links[0]?.linkType).toBe(linkType);
    }
    expect(tool.parse({ links: [{ ref: 'KODA-1', url: PLAIN_URL }] }).links[0]).toEqual({ ref: 'KODA-1', url: PLAIN_URL });
  });

  it('refuses a ref that is missing, not a string or not a ticket ref, naming its index', () => {
    const tool = toolDeps().tool;

    expect(reasonOf(() => tool.parse({ links: [{ url: PLAIN_URL }] }))).toBe('links[0].ref');
    expect(reasonOf(() => tool.parse({ links: [{ ref: 7, url: PLAIN_URL }] }))).toBe('links[0].ref');
    expect(reasonOf(() => tool.parse({ links: [{ ref: 'koda-1', url: PLAIN_URL }] }))).toBe('links[0].ref');
    expect(reasonOf(() => tool.parse({ links: [{ ref: 'KODA-1', url: PLAIN_URL }, { ref: 'KODA-0', url: PLAIN_URL }] })))
      .toBe('links[1].ref');
  });

  it('is a write tool for project members, and takes no ability beyond membership (2b1-D4)', () => {
    const tool = toolDeps().tool;
    expect(tool.descriptor).toBe(KODA_LINK_TICKETS);
    expect(tool.kind).toBe('write');
    expect(tool.key).toBe('ticket.link.add');
  });
});

describe('koda_link_tickets preview (US-005)', () => {
  it('AC-5: names the project, and infers pr for a pull request url, as the service would', async () => {
    const { tool } = toolDeps();

    const preview = await previewOf(tool, tool.parse({ links: [{ ref: 'KODA-1', url: PR_URL }] }));

    expect(preview).toBe(`Link 1 URL(s) in web:\n- KODA-1 "Fix login" <- pr ${PR_URL}`);
  });

  it('AC-6: rethrows the NotFoundAppException a ref that is no ticket of the project raises', async () => {
    const deps = toolDeps();
    const notFound = new NotFoundAppException({}, 'tickets');
    deps.findByRef.mockRejectedValue(notFound);

    const failure = await failureOf(() => previewOf(deps.tool, deps.tool.parse({ links: [{ ref: 'KODA-9', url: PLAIN_URL }] })));

    expect(failure).toBe(notFound);
  });

  it('reads every ref through the project-scoped service, in input order', async () => {
    const { findByRef, tool } = toolDeps();

    await previewOf(tool, tool.parse({
      links: [
        { ref: 'KODA-1', url: PR_URL },
        { ref: 'KODA-2', url: 'https://gitlab.com/o/r/-/merge_requests/7' },
        { ref: 'KODA-3', url: 'https://bitbucket.org/o/r/pull-requests/7' },
      ],
    }));

    expect(findByRef.mock.calls).toEqual([['web', 'KODA-1'], ['web', 'KODA-2'], ['web', 'KODA-3']]);
  });

  it('infers pr for both forge pull shapes and url for anything else, unless a linkType is given', async () => {
    const { tool } = toolDeps();

    const preview = await previewOf(tool, tool.parse({
      links: [
        { ref: 'KODA-1', url: 'https://gitlab.com/o/r/-/merge_requests/7' },
        { ref: 'KODA-1', url: 'https://bitbucket.org/o/r/pull-requests/7' },
        { ref: 'KODA-1', url: 'https://x.dev/a' },
        { ref: 'KODA-1', url: PR_URL, linkType: 'branch' },
      ],
    }));

    expect(preview.split('\n').slice(1)).toEqual([
      `- KODA-1 "Fix login" <- pr https://gitlab.com/o/r/-/merge_requests/7`,
      `- KODA-1 "Fix login" <- pr https://bitbucket.org/o/r/pull-requests/7`,
      `- KODA-1 "Fix login" <- url https://x.dev/a`,
      `- KODA-1 "Fix login" <- branch ${PR_URL}`,
    ]);
  });

  it('counts the links on its first line, and masks a token written into a url or a title', async () => {
    const { tool } = toolDeps({ ticket: { title: `Fix login token=${TOKEN}` } });

    const preview = await previewOf(tool, tool.parse({
      links: [{ ref: 'KODA-1', url: PR_URL }, { ref: 'KODA-2', url: `https://x.dev/a?token=${TOKEN}` }],
    }));

    expect(preview.split('\n')[0]).toBe('Link 2 URL(s) in web:');
    expect(preview).not.toContain(TOKEN);
    expect(preview).toContain('Fix login token=[masked]');
  });
});

describe('koda_link_tickets execute (US-005)', () => {
  it('AC-7: creates one link per entry, in order, in the context project, with the parsed url and linkType', async () => {
    const { create, tool } = toolDeps();

    await tool.execute(ctx, tool.parse({
      links: [
        { ref: 'KODA-1', url: PLAIN_URL, linkType: 'url' },
        { ref: 'KODA-2', url: 'https://github.com/o/r/pull/8', linkType: 'pr' },
      ],
    }));

    expect(create.mock.calls).toEqual([
      ['web', 'KODA-1', { url: PLAIN_URL, linkType: 'url' }],
      ['web', 'KODA-2', { url: 'https://github.com/o/r/pull/8', linkType: 'pr' }],
    ]);
  });

  it('passes no linkType when the caller gave none, so the service infers it', async () => {
    const { create, tool } = toolDeps();

    await tool.execute(ctx, tool.parse({ links: [{ ref: 'KODA-1', url: PR_URL }] }));

    expect(create.mock.calls).toEqual([['web', 'KODA-1', { url: PR_URL }]]);
  });

  it('AC-8: a service answer of 200 reads as already linked', async () => {
    const deps = toolDeps();
    deps.create.mockResolvedValueOnce({ status: 200, link: LINK });

    expect(await deps.tool.execute(ctx, deps.tool.parse({ links: [{ ref: 'KODA-1', url: PLAIN_URL }] })))
      .toBe(`linked KODA-1 ${PLAIN_URL} (already linked)`);
  });

  it('AC-9: a service answer of 201 reads as linked, with no suffix', async () => {
    const deps = toolDeps();
    deps.create.mockResolvedValueOnce({ status: 201, link: LINK });

    expect(await deps.tool.execute(ctx, deps.tool.parse({ links: [{ ref: 'KODA-2', url: PLAIN_URL }] })))
      .toBe(`linked KODA-2 ${PLAIN_URL}`);
  });

  it('AC-10: a not-found second link quotes the first line and names the link that failed', async () => {
    const deps = toolDeps();
    deps.create
      .mockResolvedValueOnce({ status: 201, link: LINK })
      .mockRejectedValueOnce(new NotFoundAppException({}, 'ticket-links'));

    const failure = await failureOf(() => deps.tool.execute(ctx, deps.tool.parse({
      links: [{ ref: 'KODA-1', url: PLAIN_URL }, { ref: 'KODA-2', url: 'https://x.dev/b' }],
    })));

    expect(failure).toBeInstanceOf(ToolActionError);
    expect((failure as ToolActionError).text).toBe(`linked KODA-1 ${PLAIN_URL}\nfailed at link 2: not_found`);
  });

  it('stops the batch at the failure, so the links after it are never attempted', async () => {
    const deps = toolDeps();
    deps.create
      .mockResolvedValueOnce({ status: 201, link: LINK })
      .mockRejectedValueOnce(new NotFoundAppException({}, 'ticket-links'));

    await failureOf(() => deps.tool.execute(ctx, deps.tool.parse({
      links: [
        { ref: 'KODA-1', url: PLAIN_URL },
        { ref: 'KODA-2', url: 'https://x.dev/b' },
        { ref: 'KODA-3', url: 'https://x.dev/c' },
      ],
    })));

    expect(deps.create).toHaveBeenCalledTimes(2);
  });

  it('leaves every other failure as the bare reason error, and a first-link failure quotes no line', async () => {
    const deps = toolDeps();
    deps.create.mockRejectedValueOnce(new Error('connection reset'));

    const failure = await failureOf(() => deps.tool.execute(ctx, deps.tool.parse({ links: [{ ref: 'KODA-1', url: PLAIN_URL }] })));

    expect(failure).toBeInstanceOf(ToolActionError);
    expect((failure as ToolActionError).text).toBe('failed at link 1: error');
  });

  it('continues past a link that was already linked (200 is not a failure)', async () => {
    const deps = toolDeps();
    deps.create
      .mockResolvedValueOnce({ status: 200, link: LINK })
      .mockResolvedValueOnce({ status: 201, link: LINK });

    const result = await deps.tool.execute(ctx, deps.tool.parse({
      links: [{ ref: 'KODA-1', url: PLAIN_URL }, { ref: 'KODA-2', url: 'https://x.dev/b' }],
    }));

    expect(result).toBe(`linked KODA-1 ${PLAIN_URL} (already linked)\nlinked KODA-2 https://x.dev/b`);
  });

  it('B2: masks a credential the url carries out of the line it answers', async () => {
    const deps = toolDeps();
    // The answer becomes the action's stored result, its outcome note and the next turn's delivery, so the URL it
    // echoes is masked exactly as the preview masks it (branch review B2).
    const result = await deps.tool.execute(ctx, deps.tool.parse({
      links: [{ ref: 'KODA-1', url: `https://x.dev/a?token=${TOKEN}` }],
    }));

    expect(result).toBe('linked KODA-1 https://x.dev/a?token=[masked]');
    expect(result).not.toContain(TOKEN);
  });

  it('B2: masks the lines a failed batch quotes, including the already-linked suffix', async () => {
    const deps = toolDeps();
    deps.create
      .mockResolvedValueOnce({ status: 200, link: LINK })
      .mockRejectedValueOnce(new NotFoundAppException({}, 'ticket-links'));

    const failure = await failureOf(() => deps.tool.execute(ctx, deps.tool.parse({
      links: [{ ref: 'KODA-1', url: `https://x.dev/a?token=${TOKEN}` }, { ref: 'KODA-2', url: 'https://x.dev/b' }],
    })));

    expect(failure).toBeInstanceOf(ToolActionError);
    const text = (failure as ToolActionError).text;
    expect(text).toBe('linked KODA-1 https://x.dev/a?token=[masked] (already linked)\nfailed at link 2: not_found');
    expect(text).not.toContain(TOKEN);
  });

  it('answers one line per link, in input order, for a longer batch', async () => {
    const deps = toolDeps();
    deps.create
      .mockResolvedValueOnce({ status: 201, link: LINK })
      .mockResolvedValueOnce({ status: 200, link: LINK })
      .mockResolvedValueOnce({ status: 201, link: LINK });

    const result = await deps.tool.execute(ctx, deps.tool.parse({
      links: [
        { ref: 'KODA-1', url: 'https://x.dev/a' },
        { ref: 'KODA-2', url: 'https://x.dev/b' },
        { ref: 'KODA-3', url: 'https://x.dev/c' },
      ],
    }));

    expect(result).toBe([
      'linked KODA-1 https://x.dev/a',
      'linked KODA-2 https://x.dev/b (already linked)',
      'linked KODA-3 https://x.dev/c',
    ].join('\n'));
    expect(deps.create).toHaveBeenCalledTimes(3);
  });
});
