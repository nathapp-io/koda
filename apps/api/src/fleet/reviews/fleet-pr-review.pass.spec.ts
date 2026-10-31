import { Logger } from '@nestjs/common';
import { currentContext, type ActionContext } from '../../action-context/action-context';
import { testFleetConfig } from '../../common/test-helpers/fleet-config';
import type { PrincipalRef } from '../../permissions/permissions.types';
import type { OpenPullRequest } from '../git-broker/github-app-client';
import type { FleetRepoRecord } from '../repos/domain/fleet-repo.domain';
import { EnablerGate } from './enabler-gate';
import { FleetPrReviewPass } from './fleet-pr-review.pass';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const POLL_MS = 300_000;
const ENABLER: PrincipalRef = { type: 'USER', id: 'u1' };

const repoRecord = (over: Partial<FleetRepoRecord> = {}): FleetRepoRecord => ({
  id: 'r1', projectId: 'p1', provider: 'github', owner: 'o', name: 'n', defaultBranch: 'main',
  githubInstallationId: 9n, createdById: 'creator', createdAt: new Date('2026-11-01T00:00:00.000Z'),
  autoReview: true, autoReviewProfiles: [], autoReviewMaxCostUsd: '1.0000',
  autoReviewEnabledById: 'u1', autoReviewEnabledByType: 'USER', autoReviewEnabledAt: new Date('2026-11-01T00:00:00.000Z'),
  ...over,
});

const PRS: readonly OpenPullRequest[] = [
  { number: 7, headSha: 'sha7', draft: false, headRepoFullName: 'o/n', updatedAt: new Date('2026-11-02T00:00:00.000Z') },
  { number: 8, headSha: 'sha8', draft: false, headRepoFullName: 'o/n', updatedAt: new Date('2026-11-03T00:00:00.000Z') },
];

/** A gate stand-in: every repo answers with the same principal, or null / a rejection. */
interface GateStub {
  check: (repo: FleetRepoRecord) => Promise<PrincipalRef | null>;
}

interface BuildOptions {
  repos?: readonly FleetRepoRecord[];
  gate?: GateStub;
  /** `prReviewMaxDispatch`; 10 unless a test needs another cap. */
  maxDispatch?: number;
  /** The call count `dispatchRepo` answers for each repo, in repo order; 1 unless stated. */
  dispatchCalls?: readonly number[];
}

function build(options: BuildOptions = {}) {
  const listed = options.repos ?? [repoRecord()];
  const calls = [...(options.dispatchCalls ?? [])];
  const gate = options.gate ?? { check: vi.fn(async () => ENABLER) };
  const contexts: (ActionContext | undefined)[] = [];
  const repoService = { listAutoReviewRepos: vi.fn(async () => [...listed]) };
  const github = {
    mintInstallationToken: vi.fn(async () => ({ token: 'tok-1', expiresAt: new Date('2026-11-14T11:00:00.000Z') })),
    listOpenPullRequests: vi.fn(async () => [...PRS]),
  };
  const dispatcher = {
    dispatchRepo: vi.fn(async () => {
      contexts.push(currentContext());
      return calls.shift() ?? 1;
    }),
  };
  const config = testFleetConfig({
    prReviewMaxDispatch: options.maxDispatch ?? 10,
    prReviewPollMs: POLL_MS,
  });
  const pass = new FleetPrReviewPass(
    repoService as never,
    gate as never,
    github as never,
    dispatcher as never,
    config,
  );
  const repoSeenBy = (call: number) => dispatcher.dispatchRepo.mock.calls[call][0];
  const remainingSeenBy = (call: number) =>
    (dispatcher.dispatchRepo.mock.calls[call][2] as { remaining: number }).remaining;
  return {
    pass, repoService, gate, github, dispatcher, config,
    contextSeenBy: (call: number) => contexts[call],
    repoSeenBy, remainingSeenBy,
  };
}

describe('FleetPrReviewPass.run', () => {
  it('AC-1: reads one page of 50 auto-review repos', async () => {
    const h = build();
    await h.pass.run(NOW);
    expect(h.repoService.listAutoReviewRepos).toHaveBeenCalledWith(50);
  });

  it("AC-2: mints an installation token with the repo's installation id and name", async () => {
    const h = build({ repos: [repoRecord({ id: 'r1', name: 'koda', githubInstallationId: 42n })] });
    await h.pass.run(NOW);
    expect(h.github.mintInstallationToken).toHaveBeenCalledWith(42n, 'koda');
  });

  it('AC-3: lists the open pull requests with the minted token, the owner and the name', async () => {
    const h = build({ repos: [repoRecord({ owner: 'nathapp', name: 'koda' })] });
    await h.pass.run(NOW);
    expect(h.github.listOpenPullRequests).toHaveBeenCalledWith('tok-1', 'nathapp', 'koda');
  });

  it('AC-4: runs the dispatcher with the repo, the listed PRs, the pass time, one poll interval and the cap', async () => {
    const h = build();
    await h.pass.run(NOW);
    expect(h.dispatcher.dispatchRepo).toHaveBeenCalledWith(repoRecord(), [...PRS], {
      now: NOW,
      pollMs: POLL_MS,
      remaining: 10,
    });
  });

  it('AC-5: dispatches inside the pr-review component action context', async () => {
    const h = build();
    await h.pass.run(NOW);
    expect(h.contextSeenBy(0)?.actor).toEqual({ type: 'SYSTEM', id: 'pr-review' });
  });

  it('AC-6: dispatches on the stored enabler’s behalf', async () => {
    const h = build();
    await h.pass.run(NOW);
    expect(h.contextSeenBy(0)?.onBehalfOf).toEqual(ENABLER);
  });

  it('AC-7: carries the calls the first repo made into the second repo’s remaining cap', async () => {
    const h = build({
      repos: [repoRecord({ id: 'r1' }), repoRecord({ id: 'r2', owner: 'o2' })],
      dispatchCalls: [7, 2],
    });
    await h.pass.run(NOW);
    expect(h.dispatcher.dispatchRepo).toHaveBeenCalledTimes(2);
    expect(h.remainingSeenBy(0)).toBe(10);
    expect(h.remainingSeenBy(1)).toBe(3);
  });

  it('AC-8: stops the pass once the cap is spent, without checking the next repo', async () => {
    const h = build({
      repos: [repoRecord({ id: 'r1' }), repoRecord({ id: 'r2', owner: 'o2' })],
      dispatchCalls: [10],
    });
    await h.pass.run(NOW);
    expect(h.dispatcher.dispatchRepo).toHaveBeenCalledTimes(1);
    expect(h.repoSeenBy(0).id).toBe('r1');
    expect(h.gate.check).toHaveBeenCalledTimes(1);
    expect(h.github.mintInstallationToken).toHaveBeenCalledTimes(1);
  });

  it('AC-9: mints no token for a repo the enabler gate turned off', async () => {
    const h = build({ gate: { check: vi.fn(async () => null) } });
    await h.pass.run(NOW);
    expect(h.gate.check).toHaveBeenCalledWith(repoRecord());
    expect(h.github.mintInstallationToken).not.toHaveBeenCalled();
    expect(h.github.listOpenPullRequests).not.toHaveBeenCalled();
    expect(h.dispatcher.dispatchRepo).not.toHaveBeenCalled();
  });

  it('AC-10: a failing list of the first repo still dispatches the second', async () => {
    const h = build({
      repos: [repoRecord({ id: 'r1' }), repoRecord({ id: 'r2', owner: 'o2' })],
      dispatchCalls: [1, 1],
    });
    h.github.listOpenPullRequests.mockRejectedValueOnce(new Error('list boom'));
    await h.pass.run(NOW);
    expect(h.dispatcher.dispatchRepo).toHaveBeenCalledTimes(1);
    expect(h.repoSeenBy(0).id).toBe('r2');
  });

  it('AC-10: a failing mint of the first repo still dispatches the second', async () => {
    const h = build({
      repos: [repoRecord({ id: 'r1' }), repoRecord({ id: 'r2', owner: 'o2' })],
      dispatchCalls: [1, 1],
    });
    h.github.mintInstallationToken.mockRejectedValueOnce(new Error('mint boom'));
    await h.pass.run(NOW);
    expect(h.dispatcher.dispatchRepo).toHaveBeenCalledTimes(1);
    expect(h.repoSeenBy(0).id).toBe('r2');
  });

  it('AC-10: a failing automatic turn-off of the first repo still dispatches the second', async () => {
    // The real gate, so the turn-off it performs on a lost-access enabler is the failure the pass must survive.
    const gate = new EnablerGate(
      { findPrincipalAccess: vi.fn(async () => ({ exists: true, disabled: false })) } as never,
      { effectiveKeys: vi.fn(async (ref: PrincipalRef) => (ref.id === 'u2' ? new Set(['fleet.job.dispatch']) : new Set<string>())) } as never,
      {
        disableAutoReview: vi.fn(async (id: string) => {
          if (id === 'r1') throw new Error('turn-off boom');
          return true;
        }),
      } as never,
    );
    const h = build({
      repos: [repoRecord({ id: 'r1' }), repoRecord({ id: 'r2', owner: 'o2', autoReviewEnabledById: 'u2' })],
      gate,
    });
    await h.pass.run(NOW);
    expect(h.dispatcher.dispatchRepo).toHaveBeenCalledTimes(1);
    expect(h.repoSeenBy(0).id).toBe('r2');
  });

  it.each<[string, (h: ReturnType<typeof build>) => void, string]>([
    ['mint', (h) => h.github.mintInstallationToken.mockRejectedValue(new TypeError('mint boom')), 'TypeError'],
    ['list', (h) => h.github.listOpenPullRequests.mockRejectedValue(new RangeError('list boom')), 'RangeError'],
    ['enabler check', (h) => vi.mocked(h.gate.check).mockRejectedValue(new Error('check boom')), 'Error'],
  ])('AC-11: warns with the repo id and the error name when %s fails', async (_name, arrange, errorName) => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockClear();
    const h = build();
    arrange(h);
    await h.pass.run(NOW);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('r1');
    expect(message).toContain(errorName);
  });

  it('AC-11: warns with the repo id and the error name when the automatic turn-off fails', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockClear();
    const gate = new EnablerGate(
      { findPrincipalAccess: vi.fn(async () => ({ exists: true, disabled: false })) } as never,
      { effectiveKeys: vi.fn(async () => new Set<string>()) } as never,
      { disableAutoReview: vi.fn(async () => { throw new SyntaxError('turn-off boom'); }) } as never,
    );
    const h = build({ gate });
    await h.pass.run(NOW);
    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain('r1');
    expect(message).toContain('SyntaxError');
  });

  it('AC-12: a rejecting enabler check for the first repo still dispatches the second', async () => {
    const h = build({
      repos: [repoRecord({ id: 'r1' }), repoRecord({ id: 'r2', owner: 'o2' })],
      gate: {
        check: vi.fn(async (repo: FleetRepoRecord) => {
          if (repo.id === 'r1') throw new Error('check boom');
          return ENABLER;
        }),
      },
    });
    await h.pass.run(NOW);
    expect(h.dispatcher.dispatchRepo).toHaveBeenCalledTimes(1);
    expect(h.repoSeenBy(0).id).toBe('r2');
  });

  it('does not poll past the first page of 50 repos and warns about the full page', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockClear();
    const page = Array.from({ length: 50 }, (_unused, index) => repoRecord({ id: `r${index + 1}` }));
    const h = build({ repos: page, gate: { check: vi.fn(async () => null) } });

    await h.pass.run(NOW);

    expect(h.repoService.listAutoReviewRepos).toHaveBeenCalledWith(50);
    expect(h.gate.check).toHaveBeenCalledTimes(50);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('50');
  });

  it('leaves no action context behind once the pass has resolved', async () => {
    const h = build();
    await h.pass.run(NOW);
    expect(currentContext()).toBeUndefined();
  });
});
