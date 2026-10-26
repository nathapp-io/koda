import { ModulesContainer } from '@nestjs/core';
import type { NathApplication } from '@nathapp/nestjs-app';
import { AssistantToolRegistry } from '../../../src/fleet/assistant/assistant-tool.registry';
import { SYSTEM_ACTOR_IDS } from '../../../src/action-context/action-context';
import { UNAUDITED_SURFACES } from '../../../src/action-context/audit-coverage.allowlist';
import { findCoverageViolations } from '../../../src/action-context/test-helpers/audit-coverage-contract';
import { collectPermissionDeclarations } from '../../../src/permissions/test-helpers/permission-contract';
import { canRunDbTests } from '../../helpers/test-environment';
import { bootHttpApp } from '../../helpers/http-app';
import { resetDb } from '../../helpers/reset-db';

const describeIntegration = canRunDbTests() ? describe : describe.skip;
const TIMEOUT = 120_000;

describeIntegration('audit coverage allowlist over the booted API (US-012)', () => {
  let app: NathApplication;
  const previousStrategy = process.env.FTS_OPTIMIZE_STRATEGY;

  beforeAll(async () => {
    process.env.FTS_OPTIMIZE_STRATEGY = 'counter';
    await resetDb();
    app = await bootHttpApp({ registrationEnabled: false });
  }, TIMEOUT);

  afterAll(async () => {
    if (previousStrategy === undefined) delete process.env.FTS_OPTIMIZE_STRATEGY;
    else process.env.FTS_OPTIMIZE_STRATEGY = previousStrategy;
    await app?.close();
  });

  it('AC-7: finds no coverage violation among live routes and system writers', () => {
    const declarations = collectPermissionDeclarations(
      app.get(ModulesContainer),
      app.get(AssistantToolRegistry),
    );

    expect(declarations.routes.length).toBeGreaterThan(200);
    expect(declarations.systemWriters.length).toBeGreaterThanOrEqual(30);
    expect(findCoverageViolations(declarations, UNAUDITED_SURFACES, SYSTEM_ACTOR_IDS)).toEqual([]);
  });
});
