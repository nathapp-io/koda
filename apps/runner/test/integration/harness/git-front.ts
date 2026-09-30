import { createGitHttp, type GitHttpRequest } from '../../helpers/git-http';

export interface GitFront {
  readonly url: string;
  readonly requests: readonly GitHttpRequest[];
  stop(): void;
}

/**
 * D91: the fake forge as the runner sees it. Git paths go to `git http-backend` and need the minted token as Basic
 * auth; every other path is proxied to the fake forge (the API's GitHub calls).
 */
export function startGitFront(forgeUrl: string, reposRoot: string, token: () => string): GitFront {
  const git = createGitHttp(reposRoot, { username: 'x-access-token', password: token });
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const answered = await git.handle(req);
      if (answered) return answered;
      const url = new URL(req.url);
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
      return fetch(`${forgeUrl}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, requests: git.requests, stop: () => { server.stop(true); } };
}
