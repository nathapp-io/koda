import type { FleetJobsService } from '../../jobs/fleet-jobs.service';
import type { KnowledgeIndexService } from '../../knowledge/knowledge-index.service';
import { ToolInputError } from '../assistant-tool.types';
import { dispatchJobTool } from './dispatch-job-tool';

const tool = dispatchJobTool({} as FleetJobsService, {} as KnowledgeIndexService);

/** The reason a parser refuses with; fails loudly when it accepts or throws something else. */
function reasonOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolInputError);
    return (error as ToolInputError).reason;
  }
  throw new Error('expected the parser to refuse this input');
}

describe('koda_dispatch_job PR parser (US-002)', () => {
  it('AC-1: accepts FIX and omits absent optional properties', () => {
    expect(tool.parse({ repo: 'acme/app', command: 'FIX', prNumber: 23, maxCostUsd: 1 })).toEqual({
      repo: 'acme/app', command: 'FIX', prNumber: 23, maxCostUsd: 1,
    });
  });

  it.each([undefined, 0, 1.5, '23', 2147483648])('AC-2: REVIEW refuses invalid prNumber %s', (prNumber) => {
    expect(reasonOf(() => tool.parse({ repo: 'acme/app', command: 'REVIEW', prNumber, maxCostUsd: 1 }))).toBe('prNumber');
  });

  it('AC-3: RUN refuses any supplied prNumber', () => {
    expect(reasonOf(() => tool.parse({ repo: 'acme/app', command: 'RUN', feature: 'add-auth', prNumber: 0, maxCostUsd: 1 }))).toBe('prNumber');
  });

  it('AC-4: PLAN still requires feature', () => {
    expect(reasonOf(() => tool.parse({ repo: 'acme/app', command: 'PLAN', maxCostUsd: 1 }))).toBe('feature');
  });

  it('AC-5: validates a supplied feature on FIX against existing bounds', () => {
    expect(reasonOf(() => tool.parse({ repo: 'acme/app', command: 'FIX', prNumber: 23, feature: 'x'.repeat(129), maxCostUsd: 1 }))).toBe('feature');
  });

  it('AC-6: preserves the exact RUN result and omits absent optional properties', () => {
    expect(tool.parse({ repo: 'acme/app', command: 'RUN', feature: 'add-auth', maxCostUsd: 0.5 })).toEqual({
      repo: 'acme/app', command: 'RUN', feature: 'add-auth', maxCostUsd: 0.5,
    });
  });

  it('AC-7: preserves the exact PLAN result', () => {
    expect(tool.parse({ repo: 'acme/app', command: 'PLAN', feature: 'add-auth', planFrom: 'docs/spec.md', maxCostUsd: 0.5 })).toEqual({
      repo: 'acme/app', command: 'PLAN', feature: 'add-auth', planFrom: 'docs/spec.md', maxCostUsd: 0.5,
    });
  });

  it.each([undefined, 0, 1.5, '23', 2147483648])('AC-8: FIX refuses invalid prNumber %s', (prNumber) => {
    expect(reasonOf(() => tool.parse({ repo: 'acme/app', command: 'FIX', prNumber, maxCostUsd: 1 }))).toBe('prNumber');
  });

  it('AC-9: RUN still requires feature', () => {
    expect(reasonOf(() => tool.parse({ repo: 'acme/app', command: 'RUN', maxCostUsd: 1 }))).toBe('feature');
  });
});
