/**
 * Lightweight API client for E2E test setup/teardown.
 * Used in beforeAll/afterAll to create and clean up test data.
 */

const API_PORT = process.env['E2E_API_PORT'] ?? '3102';
const API_URL = process.env['E2E_API_URL'] ?? `http://localhost:${API_PORT}`;

export interface LoginResult {
  token: string;
  userId: string;
}

export interface ProjectResult {
  id: string;
  slug: string;
  key: string;
}

export interface TicketResult {
  id: string;
  ref: string;
  status: string;
}

export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { token: body.data.accessToken, userId: body.data.user.id };
}

export async function createProject(
  token: string,
  data: { name: string; slug: string; key: string; description?: string },
): Promise<ProjectResult> {
  const res = await fetch(`${API_URL}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create project failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { id: body.data.id, slug: body.data.slug, key: body.data.key };
}

export async function createTicket(
  token: string,
  projectSlug: string,
  data: {
    title: string;
    type: 'BUG' | 'ENHANCEMENT';
    priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    description?: string;
    gitRefFile?: string;
    gitRefLine?: number;
    gitRefVersion?: string;
  },
): Promise<TicketResult> {
  const res = await fetch(`${API_URL}/api/projects/${projectSlug}/tickets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  });
  if (!res.ok) throw new Error(`Create ticket failed: ${res.status} ${await res.text()}`);
  const body = await res.json();
  return { id: body.data.id, ref: body.data.ref, status: body.data.status };
}

export async function deleteProject(token: string, slug: string): Promise<void> {
  await fetch(`${API_URL}/api/projects/${slug}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

/** Credentials for the seeded E2E admin user */
export const E2E_ADMIN = {
  email: 'admin@koda-e2e.test',
  password: 'E2ePassword1!',
};
