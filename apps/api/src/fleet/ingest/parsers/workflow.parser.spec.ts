import { parseWorkflowResult } from './workflow.parser';
import { INGEST_PARSER_VERSION } from '../domain/bundle-ingest.domain';

const file = (value: unknown) => ({ name: 'workflow/result.json', text: JSON.stringify(value) });
const example = {
  schemaVersion: 1,
  runId: 'fab5b9af-d3a3-41f2-91ed-62372a733c03',
  feature: 'fleet-s5a-thread-handoff',
  stories: {},
  verdict: {
    workflowPassed: true,
    outcome: 'draft',
    reasons: ['CI failed: test'],
    openItems: [{ id: '_run:cv1', kind: 'cannot-verify', severity: 'minor', file: 'apps/api/src/x.ts', line: 12, issue: 'DB-backed specs not run', suggestion: 'run test:integration' }],
  },
};

describe('parseWorkflowResult', () => {
  it('AC-1 parses the workflow verdict and details', () => {
    expect(parseWorkflowResult(file(example))).toEqual({
      runId: 'fab5b9af-d3a3-41f2-91ed-62372a733c03', outcome: 'draft', workflowPassed: true,
      reasons: ['CI failed: test'], openItems: [{ id: '_run:cv1', kind: 'cannot-verify', issue: 'DB-backed specs not run', severity: 'minor', file: 'apps/api/src/x.ts', line: 12, suggestion: 'run test:integration' }],
    });
  });

  it('AC-2 gives absent optional open-item fields null values', () => {
    expect(parseWorkflowResult(file({ ...example, verdict: { ...example.verdict, openItems: [{ id: 'i', kind: 'finding', issue: 'issue' }] } }))?.openItems).toEqual([
      { id: 'i', kind: 'finding', issue: 'issue', severity: null, file: null, line: null, suggestion: null },
    ]);
  });

  it('AC-3 caps open items at 50', () => {
    const openItems = Array.from({ length: 60 }, (_, i) => ({ id: `i${i}`, kind: 'finding', issue: 'issue' }));
    expect(parseWorkflowResult(file({ ...example, verdict: { ...example.verdict, openItems } }))?.openItems).toHaveLength(50);
  });

  it('AC-4 rejects unknown outcomes', () => {
    expect(parseWorkflowResult(file({ ...example, verdict: { ...example.verdict, outcome: 'failed' } }))).toBeNull();
  });

  it('AC-5 rejects unknown schema versions', () => {
    expect(parseWorkflowResult(file({ ...example, schemaVersion: 2 }))).toBeNull();
  });

  it('AC-6 rejects malformed JSON and absent files', () => {
    expect(parseWorkflowResult({ name: 'workflow/result.json', text: 'not JSON' })).toBeNull();
    expect(parseWorkflowResult(null)).toBeNull();
  });
});

describe('workflow ingest version', () => {
  it('AC-15 is version 2', () => expect(INGEST_PARSER_VERSION).toBe(2));
});
