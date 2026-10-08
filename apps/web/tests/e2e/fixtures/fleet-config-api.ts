const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';

/** The seeded fleet repo acme/e2e-app of project fleet-e2e (prisma/seed-e2e.ts). */
export async function fleetE2eRepoId(token: string): Promise<string> {
  const res = await fetch(`${API_URL}/api/projects/fleet-e2e/fleet/repos?size=100`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`List repos failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { data: { records: Array<{ id: string; owner: string; name: string }> } };
  const repo = body.data.records.find((r) => r.owner === 'acme' && r.name === 'e2e-app');
  if (!repo) throw new Error('acme/e2e-app is not seeded');
  return repo.id;
}

/** S3 plan C11: replaces the repo's "upstream" nax files served by the API's fake reader; returns the new head. */
export async function seedNaxFiles(token: string, repoId: string, files: Record<string, string>): Promise<string> {
  const res = await fetch(`${API_URL}/api/fleet/test-hooks/repos/${repoId}/nax-files`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ files }),
  });
  if (!res.ok) throw new Error(`Seed nax files failed: ${res.status} ${await res.text()}`);
  return ((await res.json()) as { data: { headSha: string } }).data.headSha;
}
