/**
 * Policy Gates Runner
 *
 * CLI script to run all policy gates against a project and write results to JSON artifact.
 *
 * Usage: bun scripts/policy-gates-runner.ts --project=PROJECT_ID
 *
 * Writes results to: apps/api/test/policy-gates/results.json
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { PolicyGateService } from '../src/policy/policy-gate.service';

function parseArgs() {
  const args = process.argv.slice(2);
  const result: Record<string, string> = {};

  for (const arg of args) {
    if (arg.startsWith('--')) {
      const [key, value] = arg.slice(2).split('=');
      result[key] = value;
    }
  }

  return result;
}

async function main() {
  const args = parseArgs();
  const projectId = args.project;

  if (!projectId) {
    console.error('Error: --project=PROJECT_ID is required');
    process.exit(1);
  }

  console.log(`Running policy gates for project: ${projectId}`);

  try {
    const service = new PolicyGateService();
    const result = await service.runAllGates(projectId);

    const outputDir = path.join(process.cwd(), 'test', 'policy-gates');
    await fs.mkdir(outputDir, { recursive: true });

    const outputPath = path.join(outputDir, 'results.json');
    await fs.writeFile(outputPath, JSON.stringify(result, null, 2), 'utf-8');

    console.log(`Results written to: ${outputPath}`);

    if (!result.passed) {
      console.error(`Policy gates blocked: ${result.blockedReason}`);
      process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    console.error('Error running policy gates:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
