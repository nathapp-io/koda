/**
 * Policy Gates Runner
 *
 * CLI script to run all policy gates against a project and write results to JSON artifact.
 *
 * Usage: bun scripts/policy-gates-runner.ts --project=PROJECT_ID
 *
 * Writes results to:
 *   - apps/api/test/policy-gates/results.json
 *   - apps/api/test/policy-gates/slo-snapshot.json
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { PrismaModule } from '@nathapp/nestjs-prisma';
import { PrismaClient } from '@prisma/client';
import { appConfig } from '../src/config/app.config';
import { databaseConfig } from '../src/config/database.config';
import { ragConfig } from '../src/config/rag.config';
import { vcsConfig } from '../src/config/vcs.config';
import { PolicyGateService, type PolicyGateResult, type GateResult } from '../src/policy/policy-gate.service';

// Lean bootstrap module — deliberately excludes AppModule and PolicyModule to avoid
// loading controllers with @nestjs/swagger decorators (TimelineController, MemoryController),
// which crash Bun's reflect-metadata polyfill via Reflect.getMetadata on undefined descriptor.
// PolicyGateService declares all three dependencies as @Optional, so it falls back to
// fixture data when no database is present.
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      load: [appConfig, databaseConfig, ragConfig, vcsConfig],
    }),
    PrismaModule.forRoot({ isGlobal: true, client: PrismaClient }),
  ],
  providers: [PolicyGateService],
})
class PolicyGatesRunnerModule {}

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

function printSummaryTable(projectId: string, gateResults: PolicyGateResult): void {
  console.log('\n╔════════════════════════════════════════════════════╗');
  console.log('║         Policy Gate Results                        ║');
  console.log('╠════════════════════════════════════════════════════╣');
  console.log(`║ Project: ${projectId.padEnd(42)} ║`);
  console.log('╠════════════════════════════════════════════════════╣');
  console.log('║ Gate Name                        │ Status         ║');
  console.log('╟──────────────────────────────────┼────────────────╢');

  if (!Array.isArray(gateResults.gates)) {
    console.error('Invalid gate results: gates is not an array');
    return;
  }

  for (const gate of gateResults.gates) {
    const status = gate.passed ? 'PASS' : 'FAIL';
    const paddedName = gate.name.padEnd(32);
    const paddedStatus = status.padEnd(14);
    console.log(`║ ${paddedName} │ ${paddedStatus} ║`);
  }

  console.log('╟──────────────────────────────────┴────────────────╢');
  const overallStatus = gateResults.passed ? 'PASS' : 'FAIL';
  const paddedOverall = overallStatus.padEnd(44);
  console.log(`║ Overall: ${paddedOverall} ║`);
  console.log('╚════════════════════════════════════════════════════╝\n');
}

interface SloSnapshot {
  generatedAt: string;
  projectId: string;
  dataSource: string;
  gatePassRate: number;
  gatesPassed: number;
  gatesFailed: number;
  gateResults: GateResult[];
  sloMetrics: {
    retrievalLatency: {
      p50: number;
      p95: number;
      p99: number;
      sampleCount: number;
    };
    staleHitRate: number;
    provenanceCoverage: number;
    leakageIncidents: number;
    memoryGrowthRate: number;
  };
}

function deriveSloSnapshot(projectId: string, gateResults: PolicyGateResult): SloSnapshot {
  const gates = Array.isArray(gateResults.gates) ? gateResults.gates : [];
  const gatesPassed = gates.filter((g) => g.passed).length;
  const gatesFailed = gates.filter((g) => !g.passed).length;
  const totalGates = gates.length;

  // Derive provenanceCoverage: if ProvenanceGate passed, coverage is high; otherwise, 0
  const provenanceGate = gates.find((g) => g.name === 'ProvenanceGate');
  const provenanceCoverage = provenanceGate?.passed ? 1.0 : 0.0;

  // Derive leakageIncidents: if IsolationGate failed, we know leakages happened
  const isolationGate = gates.find((g) => g.name === 'IsolationGate');
  const leakageIncidents = isolationGate?.passed ? 0 : 1;

  return {
    generatedAt: new Date().toISOString(),
    projectId,
    dataSource: 'policy-gate-run',
    gatePassRate: totalGates === 0 ? 0 : gatesPassed / totalGates,
    gatesPassed,
    gatesFailed,
    gateResults: gates,
    sloMetrics: {
      retrievalLatency: {
        p50: 0,
        p95: 0,
        p99: 0,
        sampleCount: 0,
      },
      staleHitRate: 0,
      provenanceCoverage,
      leakageIncidents,
      memoryGrowthRate: 0,
    },
  };
}

async function main() {
  const args = parseArgs();
  const projectId = args.project;

  if (!projectId) {
    console.error('Error: --project=PROJECT_ID is required');
    process.exit(1);
  }

  console.log(`Running policy gates for project: ${projectId}`);

  const app = await NestFactory.createApplicationContext(PolicyGatesRunnerModule, { logger: false });

  try {
    const service = app.get(PolicyGateService);
    const result = await service.runAllGates(projectId);

    const outputDir = path.join(process.cwd(), 'test', 'policy-gates');
    await fs.mkdir(outputDir, { recursive: true });

    const resultsPath = path.join(outputDir, 'results.json');
    await fs.writeFile(resultsPath, JSON.stringify(result, null, 2), 'utf-8');
    console.log(`Results written to: ${resultsPath}`);

    const sloSnapshot = deriveSloSnapshot(projectId, result);
    const snapshotPath = path.join(outputDir, 'slo-snapshot.json');
    await fs.writeFile(snapshotPath, JSON.stringify(sloSnapshot, null, 2), 'utf-8');
    console.log(`SLO snapshot written to: ${snapshotPath}`);

    printSummaryTable(projectId, result);

    if (!result.passed) {
      console.error(`Policy gates blocked: ${result.blockedReason}`);
      process.exit(1);
    }

    process.exit(0);
  } catch (error) {
    console.error('Error running policy gates:', error);
    process.exit(1);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
