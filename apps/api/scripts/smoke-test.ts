#!/usr/bin/env bun
/**
 * smoke-test.ts — Koda API smoke test
 *
 * Usage:
 *   bun run scripts/smoke-test.ts [--base-url http://localhost:3100] [--out smoke-result.txt]
 *
 * Starts with registration/login, then exercises all major endpoints.
 * Outputs a structured report to the specified file.
 */

import { writeFileSync } from 'fs';

// ─── Config ────────────────────────────────────────────────────────────────

const BASE_URL = process.argv.includes('--base-url')
  ? process.argv[process.argv.indexOf('--base-url') + 1]
  : 'http://localhost:3100';

const OUT_FILE = process.argv.includes('--out')
  ? process.argv[process.argv.indexOf('--out') + 1]
  : 'smoke-result.txt';

const TEST_USER = {
  email: `smoke-${Date.now()}@test.koda`,
  password: 'Smoke@Test123!',
  name: 'Smoke Tester',
};

const TEST_PROJECT = {
  name: `Smoke Project ${Date.now()}`,
  slug: `smoke-${Date.now()}`,
  description: 'Auto-generated smoke test project',
};

// ─── Types ─────────────────────────────────────────────────────────────────

interface TestResult {
  step: number;
  name: string;
  method: string;
  url: string;
  status: number;
  pass: boolean;
  duration: number;
  detail?: string;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function req(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

// ─── Test runner ───────────────────────────────────────────────────────────

const results: TestResult[] = [];
let step = 0;

async function test(
  name: string,
  method: string,
  path: string,
  options: {
    body?: unknown;
    token?: string;
    expectStatus?: number | number[];
    expectRetZero?: boolean;
    extract?: (data: unknown) => string | undefined;
  } = {},
): Promise<unknown> {
  step++;
  const t0 = Date.now();
  const expectedStatus = options.expectStatus ?? [200, 201];
  const statuses = Array.isArray(expectedStatus) ? expectedStatus : [expectedStatus];

  let status = 0;
  let data: unknown = null;
  let detail: string | undefined;
  let pass = false;

  try {
    const res = await req(method, path, options.body, options.token);
    status = res.status;
    data = res.data;

    const statusOk = statuses.includes(status);
    const retOk =
      options.expectRetZero === false
        ? true
        : typeof data === 'object' && data !== null && 'ret' in data
          ? (data as { ret: number }).ret === 0
          : true; // skip ret check if not a JsonResponse

    pass = statusOk && retOk;

    if (options.extract) {
      detail = options.extract(data);
    }
    if (!pass) {
      detail = `status=${status} (expected ${statuses.join('|')}), body=${JSON.stringify(data).slice(0, 200)}`;
    }
  } catch (err) {
    detail = `ERROR: ${err instanceof Error ? err.message : String(err)}`;
    pass = false;
  }

  results.push({
    step,
    name,
    method,
    url: `${BASE_URL}${path}`,
    status,
    pass,
    duration: Date.now() - t0,
    detail,
  });

  const icon = pass ? '✅' : '❌';
  console.log(`${icon} [${step}] ${name} (${status}) ${pass ? '' : `→ ${detail}`}`);

  return data;
}

// ─── Smoke tests ───────────────────────────────────────────────────────────

async function run() {
  console.log(`\n🚀 Koda API Smoke Test`);
  console.log(`   Base URL : ${BASE_URL}`);
  console.log(`   Output   : ${OUT_FILE}`);
  console.log(`   Started  : ${new Date().toISOString()}\n`);

  // Check connectivity first
  const ping = await req('GET', '/api/projects').catch(() => null);
  if (!ping) {
    console.error(`❌ Cannot reach API at ${BASE_URL}. Is the server running?`);
    process.exit(1);
  }

  let accessToken = '';
  let refreshToken = '';
  let projectSlug = '';
  let ticketRef = '';
  let labelId = '';
  let commentId = '';

  // ── Auth ────────────────────────────────────────────────────────────────
  const registerData = await test('Register user', 'POST', '/api/auth/register', {
    body: TEST_USER,
    expectStatus: 201,
  }) as { data?: { accessToken?: string; refreshToken?: string } };

  if (registerData && typeof registerData === 'object' && 'data' in registerData) {
    const d = (registerData as { data: { accessToken: string; refreshToken: string } }).data;
    accessToken = d?.accessToken ?? '';
    refreshToken = d?.refreshToken ?? '';
  }

  if (!accessToken) {
    // Try login as fallback (user may already exist)
    const loginData = await test('Login (fallback)', 'POST', '/api/auth/login', {
      body: { email: TEST_USER.email, password: TEST_USER.password },
      expectStatus: 200,
    }) as { data?: { accessToken?: string; refreshToken?: string } };

    if (loginData && typeof loginData === 'object' && 'data' in loginData) {
      const d = (loginData as { data: { accessToken: string; refreshToken: string } }).data;
      accessToken = d?.accessToken ?? '';
      refreshToken = d?.refreshToken ?? '';
    }
  }

  await test('Refresh token', 'POST', '/api/auth/refresh', {
    body: { refreshToken },
    expectStatus: 200,
  });

  await test('Get current user (me)', 'GET', '/api/auth/me', {
    token: accessToken,
    expectStatus: 200,
  });

  // ── Projects ─────────────────────────────────────────────────────────────
  await test('List projects (empty)', 'GET', '/api/projects', {
    token: accessToken,
    expectStatus: 200,
  });

  const createProjectData = await test('Create project', 'POST', '/api/projects', {
    token: accessToken,
    body: TEST_PROJECT,
    expectStatus: 201,
  });

  if (createProjectData && typeof createProjectData === 'object' && 'data' in createProjectData) {
    const d = (createProjectData as { data: { slug: string } }).data;
    projectSlug = d?.slug ?? TEST_PROJECT.slug;
  } else {
    projectSlug = TEST_PROJECT.slug;
  }

  await test('Get project by slug', 'GET', `/api/projects/${projectSlug}`, {
    token: accessToken,
    expectStatus: 200,
  });

  await test('Update project', 'PATCH', `/api/projects/${projectSlug}`, {
    token: accessToken,
    body: { description: 'Updated by smoke test' },
    expectStatus: 200,
  });

  // ── Labels ───────────────────────────────────────────────────────────────
  const createLabelData = await test('Create label', 'POST', `/api/projects/${projectSlug}/labels`, {
    token: accessToken,
    body: { name: 'smoke-label', color: '#ff0000' },
    expectStatus: 201,
  });

  if (createLabelData && typeof createLabelData === 'object' && 'data' in createLabelData) {
    const d = (createLabelData as { data: { id: string } }).data;
    labelId = d?.id ?? '';
  }

  await test('List labels', 'GET', `/api/projects/${projectSlug}/labels`, {
    token: accessToken,
    expectStatus: 200,
  });

  // ── Tickets ──────────────────────────────────────────────────────────────
  const createTicketData = await test('Create ticket', 'POST', `/api/projects/${projectSlug}/tickets`, {
    token: accessToken,
    body: {
      title: 'Smoke test ticket',
      description: 'Auto-created by smoke test',
      type: 'FEATURE',
      priority: 'MEDIUM',
    },
    expectStatus: 201,
  });

  if (createTicketData && typeof createTicketData === 'object' && 'data' in createTicketData) {
    const d = (createTicketData as { data: { ref: string } }).data;
    ticketRef = d?.ref ?? '';
  }

  await test('List tickets', 'GET', `/api/projects/${projectSlug}/tickets`, {
    token: accessToken,
    expectStatus: 200,
  });

  await test('Get ticket by ref', 'GET', `/api/projects/${projectSlug}/tickets/${ticketRef}`, {
    token: accessToken,
    expectStatus: 200,
  });

  await test('Update ticket', 'PATCH', `/api/projects/${projectSlug}/tickets/${ticketRef}`, {
    token: accessToken,
    body: { description: 'Updated by smoke test' },
    expectStatus: 200,
  });

  if (labelId) {
    await test('Add label to ticket', 'POST', `/api/projects/${projectSlug}/tickets/${ticketRef}/labels`, {
      token: accessToken,
      body: { labelId },
      expectStatus: 201,
    });
  }

  // ── Ticket state transitions ──────────────────────────────────────────────
  await test('Start ticket', 'POST', `/api/projects/${projectSlug}/tickets/${ticketRef}/start`, {
    token: accessToken,
    expectStatus: 200,
  });

  await test('Fix ticket', 'POST', `/api/projects/${projectSlug}/tickets/${ticketRef}/fix`, {
    token: accessToken,
    expectStatus: 200,
  });

  await test('Verify ticket', 'POST', `/api/projects/${projectSlug}/tickets/${ticketRef}/verify`, {
    token: accessToken,
    expectStatus: 200,
  });

  // ── Comments ─────────────────────────────────────────────────────────────
  const createCommentData = await test('Create comment', 'POST', `/api/projects/${projectSlug}/tickets/${ticketRef}/comments`, {
    token: accessToken,
    body: { content: 'Smoke test comment' },
    expectStatus: 201,
  });

  if (createCommentData && typeof createCommentData === 'object' && 'data' in createCommentData) {
    const d = (createCommentData as { data: { id: string } }).data;
    commentId = d?.id ?? '';
  }

  await test('List comments', 'GET', `/api/projects/${projectSlug}/tickets/${ticketRef}/comments`, {
    token: accessToken,
    expectStatus: 200,
  });

  if (commentId) {
    await test('Update comment', 'PATCH', `/api/comments/${commentId}`, {
      token: accessToken,
      body: { content: 'Updated smoke test comment' },
      expectStatus: 200,
    });

    await test('Delete comment', 'DELETE', `/api/comments/${commentId}`, {
      token: accessToken,
      expectStatus: 200,
    });
  }

  // ── Auth guards ───────────────────────────────────────────────────────────
  await test('Unauthenticated request should return 401', 'GET', '/api/projects', {
    expectStatus: 401,
    expectRetZero: false,
  });

  // ─── Report ───────────────────────────────────────────────────────────────
  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const total = results.length;
  const duration = results.reduce((sum, r) => sum + r.duration, 0);

  const lines: string[] = [
    '═══════════════════════════════════════════════════════════════',
    ' KODA API SMOKE TEST REPORT',
    `  Date     : ${new Date().toISOString()}`,
    `  Base URL : ${BASE_URL}`,
    `  Branch   : feat/refactor-standard`,
    '═══════════════════════════════════════════════════════════════',
    '',
    `  RESULT   : ${failed === 0 ? '✅ ALL PASSED' : `❌ ${failed} FAILED`}`,
    `  Tests    : ${passed}/${total} passed`,
    `  Duration : ${duration}ms total`,
    '',
    '───────────────────────────────────────────────────────────────',
    ' DETAILS',
    '───────────────────────────────────────────────────────────────',
    ...results.map(r =>
      [
        `  [${r.step.toString().padStart(2, '0')}] ${r.pass ? 'PASS' : 'FAIL'}  ${r.method.padEnd(6)} ${r.url.replace(BASE_URL, '')}  (${r.status} / ${r.duration}ms)`,
        r.detail ? `        → ${r.detail}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
    '',
    '───────────────────────────────────────────────────────────────',
    failed === 0
      ? ' ✅ Smoke test passed. API is healthy.'
      : ` ❌ ${failed} test(s) failed. See details above.`,
    '═══════════════════════════════════════════════════════════════',
  ];

  const report = lines.join('\n');
  console.log('\n' + report);
  writeFileSync(OUT_FILE, report, 'utf-8');
  console.log(`\n📄 Report saved to: ${OUT_FILE}`);

  process.exit(failed > 0 ? 1 : 0);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
