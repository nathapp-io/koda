import type { ConfigType } from '@nestjs/config';
import type { fleetConfig } from '../../config/fleet.config';
import { AfterCommitService } from '../../permissions/after-commit.service';
import type { PermissionService } from '../../permissions/permission.service';
import type { UserPrincipal } from '../../auth/principal/koda-principal.types';
import type { FleetJobsService } from '../jobs/fleet-jobs.service';
import { FleetCommandType } from '../../common/enums';
import type { ChatThreadRecord, ChatThreadRepository } from './domain/chat-thread.domain';
import { cancelUnstartedTurn } from './thread-stop';
import { ThreadsService } from './threads.service';
import { WorkspaceThreadsService } from './workspace-threads.service';

/**
 * #428: a SESSION turn no runner has started is cancelled server-side. A turn a runner took first goes down the
 * stop command path, which stops a RUNNING turn or answers noSession.
 */
const turn = { jobId: 'j9', projectId: 'p1' };
const projectAudit = { key: 'thread.stop', resourceType: 'thread', resourceId: 't1', projectId: 'p1', summary: 'stop cancelled the queued turn' };

describe('cancelUnstartedTurn (#428)', () => {
  it('cancels before a runner with the thread stop audit entry of a project thread', async () => {
    const jobs = { cancelBeforeRunner: vi.fn(async () => true) };
    await expect(cancelUnstartedTurn(jobs as unknown as FleetJobsService, 'u1', turn, { id: 't1', workspace: false })).resolves.toBe(true);
    expect(jobs.cancelBeforeRunner).toHaveBeenCalledExactlyOnceWith('u1', 'p1', 'j9', projectAudit);
  });

  it('records the stop under the thread.stop key for a workspace thread too', async () => {
    const jobs = { cancelBeforeRunner: vi.fn(async () => true) };
    await cancelUnstartedTurn(jobs as unknown as FleetJobsService, 'u1', turn, { id: 't1', workspace: true });
    expect(jobs.cancelBeforeRunner).toHaveBeenCalledWith('u1', 'p1', 'j9', expect.objectContaining({ key: 'thread.stop', resourceId: 't1' }));
  });

  it('answers false when a runner took the turn first', async () => {
    const jobs = { cancelBeforeRunner: vi.fn(async () => false) };
    await expect(cancelUnstartedTurn(jobs as unknown as FleetJobsService, 'u1', turn, { id: 't1', workspace: false })).resolves.toBe(false);
  });
});

describe('ThreadsService.stop (#428)', () => {
  const setup = (unstarted: typeof turn | null, cancelled = true) => {
    const threads = { unstartedTurnJob: vi.fn(async () => unstarted), command: vi.fn(async () => undefined) };
    const cancelBeforeRunner = vi.fn(async () => cancelled);
    const service = new ThreadsService(
      threads as unknown as ChatThreadRepository, {} as never, {} as never,
      { threadsEnabled: true } as unknown as ConfigType<typeof fleetConfig>,
      { cancelBeforeRunner } as unknown as FleetJobsService, {} as never, new AfterCommitService(), {} as PermissionService, {} as never,
    );
    return { service, threads, cancelBeforeRunner };
  };

  it('cancels an unstarted turn and sends no stop command', async () => {
    const { service, threads, cancelBeforeRunner } = setup(turn);
    await service.stop('p1', 't1', 'u1', true);
    expect(threads.unstartedTurnJob).toHaveBeenCalledExactlyOnceWith({ kind: 'project', projectId: 'p1' }, 't1', 'u1', true);
    expect(cancelBeforeRunner).toHaveBeenCalledExactlyOnceWith('u1', 'p1', 'j9', projectAudit);
    expect(threads.command).not.toHaveBeenCalled();
  });

  it('keeps the stop command path when no turn is unstarted', async () => {
    const { service, threads, cancelBeforeRunner } = setup(null);
    await service.stop('p1', 't1', 'u1');
    expect(threads.unstartedTurnJob).toHaveBeenCalledWith({ kind: 'project', projectId: 'p1' }, 't1', 'u1', false);
    expect(cancelBeforeRunner).not.toHaveBeenCalled();
    expect(threads.command).toHaveBeenCalledExactlyOnceWith({ kind: 'project', projectId: 'p1' }, 't1', 'u1', FleetCommandType.THREAD_STOP_TURN, {}, false);
  });

  it('falls back to the stop command when a runner took the turn before the cancel', async () => {
    const { service, threads } = setup(turn, false);
    await service.stop('p1', 't1', 'u1');
    expect(threads.command).toHaveBeenCalledExactlyOnceWith({ kind: 'project', projectId: 'p1' }, 't1', 'u1', FleetCommandType.THREAD_STOP_TURN, {}, false);
  });
});

describe('WorkspaceThreadsService.stop (#428)', () => {
  const principal = { id: 'u', actorType: 'user', role: 'MEMBER', email: 'u@example.com' } as UserPrincipal;
  const record = { id: 't1', projectId: 'p1', createdById: 'u', createdByType: 'USER' } as unknown as ChatThreadRecord;

  const setup = (unstarted: typeof turn | null) => {
    const threads = {
      get: vi.fn(async () => record), unstartedTurnJob: vi.fn(async () => unstarted), command: vi.fn(async () => undefined),
    };
    const cancelBeforeRunner = vi.fn(async () => true);
    const can = vi.fn(async () => ({ allowed: true, reason: 'granted' }));
    const service = new WorkspaceThreadsService(
      threads as unknown as ChatThreadRepository, {} as never, {} as never, { threadsEnabled: true } as never, {} as never,
      {} as never, { can } as unknown as PermissionService, { cancelBeforeRunner } as unknown as FleetJobsService, new AfterCommitService(), {} as never,
    );
    return { service, threads, cancelBeforeRunner, can };
  };

  it('cancels an unstarted turn through the workspace scope after the stop key check', async () => {
    const { service, threads, cancelBeforeRunner, can } = setup(turn);
    await service.stop(principal, 't1');
    expect(can).toHaveBeenCalledWith(principal, 'thread.stop', expect.objectContaining({ projectId: 'p1' }));
    expect(threads.unstartedTurnJob).toHaveBeenCalledExactlyOnceWith({ kind: 'workspace', userId: 'u' }, 't1', 'u');
    expect(cancelBeforeRunner).toHaveBeenCalledExactlyOnceWith('u', 'p1', 'j9', expect.objectContaining({ key: 'thread.stop', resourceId: 't1' }));
    expect(threads.command).not.toHaveBeenCalled();
  });

  it('keeps the stop command path when no turn is unstarted', async () => {
    const { service, threads, cancelBeforeRunner } = setup(null);
    await service.stop(principal, 't1');
    expect(cancelBeforeRunner).not.toHaveBeenCalled();
    expect(threads.command).toHaveBeenCalledExactlyOnceWith({ kind: 'workspace', userId: 'u' }, 't1', 'u', FleetCommandType.THREAD_STOP_TURN, {});
  });
});
