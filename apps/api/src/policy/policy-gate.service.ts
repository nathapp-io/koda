/**
 * PolicyGateService
 *
 * Enforces memory invariants through automated gates that run in CI:
 * - IsolationGate: No cross-project data access
 * - ProvenanceGate: All search responses have provenance.sources populated
 * - TruthConsistencyGate: Canonical state matches derived Prisma data
 * - WriteGate: All writes go through approved layers
 * - GraphifyEnabledGate: Code results hidden when graphifyEnabled=false
 * - TokenBudgetGate: Context stays within 5% tolerance of tokenBudget
 */

import { Injectable } from '@nestjs/common';

/**
 * Result for a single gate execution
 */
export interface GateResult {
  name: string;
  passed: boolean;
  details?: string;
  error?: string;
}

/**
 * Aggregated result from running all policy gates
 */
export interface PolicyGateResult {
  passed: boolean;
  gates: GateResult[];
  blockedReason?: string;
}

@Injectable()
export class PolicyGateService {
  /**
   * Runs all policy gates against a project in a test database
   *
   * @param _projectId - The project ID to test (must exist in test DB)
   * @returns PolicyGateResult with gate-by-gate results
   */
  async runAllGates(_projectId: string): Promise<PolicyGateResult> {
    // TODO: Implement
    // 1. Run IsolationGate
    // 2. Run ProvenanceGate
    // 3. Run TruthConsistencyGate
    // 4. Run WriteGate
    // 5. Run GraphifyEnabledGate
    // 6. Run TokenBudgetGate
    // 7. Aggregate results and set blockedReason if any failed

    throw new Error('PolicyGateService.runAllGates not yet implemented');
  }
}
