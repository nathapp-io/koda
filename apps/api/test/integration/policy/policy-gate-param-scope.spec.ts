/**
 * Failing tests for three bugs found by adversarial review in policy-gate.service.ts.
 *
 * Each test documents spec-correct behavior.  It FAILS with the current (buggy)
 * implementation and must PASS once the implementer applies the corresponding fix.
 *
 * Bugs targeted:
 *  - [error] line 191 — IsolationGate: parameter `_projectId` is unused; gate
 *    always scopes fixture queries to hardcoded FIXTURE_PROJECT_A instead of the
 *    caller-provided projectId.
 *  - [error] line 236 — ProvenanceGate: parameter `_projectId` is unused; gate
 *    always passes hardcoded FIXTURE_PROJECT_A to searchFixture instead of the
 *    caller-provided projectId.
 *  - [error] line 372 — GraphifyEnabledGate: parameter `_projectId` is unused;
 *    gate always scopes queries and the graphify-enabled lookup to hardcoded
 *    FIXTURE_GRAPHIFY_OFF instead of the caller-provided projectId.
 *
 * Strategy: spy on the private helpers (accessible at runtime despite TypeScript
 * visibility rules) and assert that the helpers receive the projectId that was
 * passed to runAllGates(), not the hardcoded fixture constant.
 */

import { PolicyGateService } from '../../../src/policy/policy-gate.service';

// Mirror the private constants so tests are self-describing.
const FIXTURE_PROJECT_A = 'gate-fixture-project-a';
const FIXTURE_PROJECT_B = 'gate-fixture-project-b';
const FIXTURE_GRAPHIFY_OFF = 'gate-fixture-graphify-off';

describe('PolicyGateService — parameter-scope bugs (adversarial review)', () => {
  // -------------------------------------------------------------------------
  // Bug 1 — IsolationGate (policy-gate.service.ts line 191)
  // -------------------------------------------------------------------------
  describe('IsolationGate — should scope fixture queries to the provided projectId', () => {
    it('passes the caller-provided projectId to queryProjectScoped, not hardcoded FIXTURE_PROJECT_A', async () => {
      const service = new PolicyGateService();
      const queriedProjectIds: string[] = [];

      // Intercept the private queryProjectScoped so we can observe every call.
      const origQuery = (service as any).queryProjectScoped.bind(service);
      (service as any).queryProjectScoped = async (projectId: string, query: string) => {
        queriedProjectIds.push(projectId);
        return origQuery(projectId, query);
      };

      // Provide FIXTURE_PROJECT_B as the target — different from the hardcoded value.
      await service.runAllGates(FIXTURE_PROJECT_B);

      const queried = new Set(queriedProjectIds);

      // Spec: IsolationGate must scope its fixture selection to the provided projectId.
      // Bug: the gate ignores _projectId and always queries FIXTURE_PROJECT_A.
      expect(queried.has(FIXTURE_PROJECT_B)).toBe(true);
      // FIXTURE_PROJECT_A must not appear — no gate should be reaching for it when
      // the caller asked for FIXTURE_PROJECT_B.
      expect(queried.has(FIXTURE_PROJECT_A)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Bug 2 — ProvenanceGate (policy-gate.service.ts line 236)
  // -------------------------------------------------------------------------
  describe('ProvenanceGate — should scope fixture searches to the provided projectId', () => {
    it('passes the caller-provided projectId to searchFixture, not hardcoded FIXTURE_PROJECT_A', async () => {
      const service = new PolicyGateService();
      const searchedProjectIds: string[] = [];

      // Intercept the private searchFixture so we can observe every call.
      const origSearch = (service as any).searchFixture.bind(service);
      (service as any).searchFixture = async (projectId: string, query: string) => {
        searchedProjectIds.push(projectId);
        return origSearch(projectId, query);
      };

      // Provide FIXTURE_PROJECT_B as the target — different from the hardcoded value.
      await service.runAllGates(FIXTURE_PROJECT_B);

      const searched = new Set(searchedProjectIds);

      // Spec: ProvenanceGate must scope searches to the provided projectId.
      // Bug: the gate ignores _projectId and always passes FIXTURE_PROJECT_A.
      expect(searched.has(FIXTURE_PROJECT_B)).toBe(true);
      // FIXTURE_PROJECT_A must not appear in provenance searches when the caller
      // asked for FIXTURE_PROJECT_B.
      expect(searched.has(FIXTURE_PROJECT_A)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Bug 3 — GraphifyEnabledGate (policy-gate.service.ts line 372)
  // -------------------------------------------------------------------------
  describe('GraphifyEnabledGate — should scope queries and graphify lookup to the provided projectId', () => {
    it('passes the caller-provided projectId to getProjectGraphifyEnabled, not hardcoded FIXTURE_GRAPHIFY_OFF', async () => {
      const service = new PolicyGateService();
      const graphifyCheckedProjectIds: string[] = [];

      // Intercept the private getProjectGraphifyEnabled so we can observe calls.
      const origGraphify = (service as any).getProjectGraphifyEnabled.bind(service);
      (service as any).getProjectGraphifyEnabled = async (projectId: string) => {
        graphifyCheckedProjectIds.push(projectId);
        return origGraphify(projectId);
      };

      // Provide FIXTURE_PROJECT_A as the target — different from FIXTURE_GRAPHIFY_OFF.
      await service.runAllGates(FIXTURE_PROJECT_A);

      // Spec: GraphifyEnabledGate must look up graphify status for the provided projectId.
      // Bug: the gate ignores _projectId and always checks FIXTURE_GRAPHIFY_OFF.
      expect(graphifyCheckedProjectIds).toContain(FIXTURE_PROJECT_A);
      expect(graphifyCheckedProjectIds).not.toContain(FIXTURE_GRAPHIFY_OFF);
    });

    it('passes the caller-provided projectId to queryProjectScoped, not hardcoded FIXTURE_GRAPHIFY_OFF', async () => {
      const service = new PolicyGateService();
      const queriedProjectIds: string[] = [];

      const origQuery = (service as any).queryProjectScoped.bind(service);
      (service as any).queryProjectScoped = async (projectId: string, query: string) => {
        queriedProjectIds.push(projectId);
        return origQuery(projectId, query);
      };

      // Provide FIXTURE_PROJECT_A as the target — different from FIXTURE_GRAPHIFY_OFF.
      await service.runAllGates(FIXTURE_PROJECT_A);

      // Spec: GraphifyEnabledGate must scope its project queries to the provided projectId.
      // Bug: the gate ignores _projectId and always queries FIXTURE_GRAPHIFY_OFF.
      expect(queriedProjectIds).not.toContain(FIXTURE_GRAPHIFY_OFF);
    });
  });
});
