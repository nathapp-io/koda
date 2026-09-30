// apps/runner/test/helpers/git-http.ts
/** Smart HTTP over `git http-backend` (CGI) with Basic auth: the only way a test can make git call a credential helper. */
export interface GitHttpRequest {
  readonly path: string;
  readonly withAuth: boolean;
  readonly authorized: boolean;
}

export interface GitHttpAuth {
  readonly username: string;
  readonly password: () => string;
}

const GIT_PATH = /^\/.+\.git\/(?:info\/refs|git-upload-pack|git-receive-pack)$/;

function splitCgi(out: Uint8Array): { head: string; body: Uint8Array } {
  for (const sep of ['\r\n\r\n', '\n\n']) {
    const bytes = new TextEncoder().encode(sep);
    for (let i = 0; i + bytes.length <= out.length; i += 1) {
      if (bytes.every((b, j) => out[i + j] === b)) return { head: new TextDecoder().decode(out.slice(0, i)), body: out.slice(i + bytes.length) };
    }
  }
  return { head: '', body: out };
}

async function runBackend(root: string, req: Request, url: URL, user: string): Promise<Response> {
  const body = new Uint8Array(await req.arrayBuffer());
  const proc = Bun.spawn(['git', 'http-backend'], {
    stdin: body, stdout: 'pipe', stderr: 'pipe',
    env: {
      PATH: process.env['PATH'], GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname,
      QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers.get('content-type') ?? '',
      CONTENT_LENGTH: String(body.length), HTTP_CONTENT_ENCODING: req.headers.get('content-encoding') ?? '',
      REMOTE_USER: user, REMOTE_ADDR: '127.0.0.1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer());
  await proc.exited;
  const { head, body: rest } = splitCgi(out);
  const headers = new Headers();
  let status = 200;
  for (const line of head.split(/\r?\n/).filter(Boolean)) {
    const colon = line.indexOf(':');
    const [name, value] = [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    if (name.toLowerCase() === 'status') status = Number(value.split(' ')[0]);
    else headers.set(name, value);
  }
  return new Response(rest, { status, headers });
}

/** `handle` answers git paths (401 without the right Basic auth) and returns null for anything else. */
export function createGitHttp(root: string, auth: GitHttpAuth): { handle(req: Request): Promise<Response | null>; readonly requests: readonly GitHttpRequest[] } {
  const requests: GitHttpRequest[] = [];
  return {
    requests,
    async handle(req) {
      const url = new URL(req.url);
      if (!GIT_PATH.test(url.pathname)) return null;
      const header = req.headers.get('authorization');
      const authorized = header === `Basic ${Buffer.from(`${auth.username}:${auth.password()}`).toString('base64')}`;
      requests.push({ path: `${url.pathname}${url.search}`, withAuth: header !== null, authorized });
      if (!authorized) return new Response('authentication required\n', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="git"' } });
      return runBackend(root, req, url, auth.username);
    },
  };
}

export function startGitHttp(root: string, auth: GitHttpAuth): { url: string; requests: readonly GitHttpRequest[]; stop(): void } {
  const git = createGitHttp(root, auth);
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (req) => (await git.handle(req)) ?? new Response('not found', { status: 404 }) });
  return { url: `http://127.0.0.1:${server.port}`, requests: git.requests, stop: () => { server.stop(true); } };
}
