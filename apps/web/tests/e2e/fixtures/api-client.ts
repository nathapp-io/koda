/**
 * Lightweight API client for E2E test setup/teardown.
 * Used in beforeAll/afterAll to create and clean up test data.
 */

const API_URL = process.env['E2E_API_URL'] ?? 'http://localhost:3102';

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

export interface AgentResult {
  slug: string;
}

export type TicketTransitionAction = 'verify' | 'start' | 'fix' | 'verify-fix' | 'reject' | 'close';

export async function login(email: string, password: string): Promise<LoginResult> {
  const res = await fetch(`${API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    data?: { accessToken?: string; user?: { id?: string } };
  };
  const token = body.data?.accessToken;
  const userId = body.data?.user?.id;

  if (!token || !userId) {
    throw new Error('Login response missing access token or user id');
  }

  return { token, userId };
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
  const body = (await res.json()) as {
    data?: { id?: string; slug?: string; key?: string };
  };

  if (!body.data?.id || !body.data.slug || !body.data.key) {
    throw new Error('Create project response missing id, slug, or key');
  }

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
  const body = (await res.json()) as {
    data?: { id?: string; ref?: string; status?: string };
  };

  if (!body.data?.id || !body.data.ref || !body.data.status) {
    throw new Error('Create ticket response missing id, ref, or status');
  }

  return { id: body.data.id, ref: body.data.ref, status: body.data.status };
}

export async function transitionTicket(
  token: string,
  projectSlug: string,
  ticketRef: string,
  action: TicketTransitionAction,
  body?: { body?: string },
  query?: Record<string, string | boolean | number | undefined>,
): Promise<void> {
  const params = new URLSearchParams();

  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }
  }

  const queryString = params.toString();
  const path = `${API_URL}/api/projects/${projectSlug}/tickets/${ticketRef}/${action}${
    queryString ? `?${queryString}` : ''
  }`;

  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body ?? {}),
  });

  if (!res.ok) {
    throw new Error(`Transition ${action} failed: ${res.status} ${await res.text()}`);
  }
}

export async function deleteProject(token: string, slug: string): Promise<void> {
  await fetch(`${API_URL}/api/projects/${slug}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
}

export async function createAgent(
  token: string,
  data: { name: string; slug: string },
): Promise<AgentResult> {
  const res = await fetch(`${API_URL}/api/agents`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(data),
  });

  if (!res.ok) {
    throw new Error(`Create agent failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as {
    data?: { slug?: string };
  };

  const slug = body.data?.slug ?? data.slug;

  if (!slug) {
    throw new Error('Create agent response missing slug');
  }

  return { slug };
}

export async function deleteAgent(token: string, slug: string): Promise<void> {
  const res = await fetch(`${API_URL}/api/agents/${slug}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok && res.status !== 404) {
    throw new Error(`Delete agent failed: ${res.status} ${await res.text()}`);
  }
}

export async function updateAgentStatus(
  token: string,
  slug: string,
  status: 'ACTIVE' | 'PAUSED' | 'OFFLINE',
): Promise<void> {
  const res = await fetch(`${API_URL}/api/agents/${slug}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status }),
  });

  if (!res.ok) {
    throw new Error(`Update agent status failed: ${res.status} ${await res.text()}`);
  }
}

/** Credentials for the seeded E2E admin user */
export const E2E_ADMIN = {
  email: 'admin@koda-e2e.test',
  password: 'E2ePassword1!',
};
