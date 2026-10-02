import { createGitHttp, type GitHttpRequest } from '../../helpers/git-http';

/** D153: holds git's push discovery so a test can land an ABANDON between nax exit and the progress push. */
export interface PushHold {
  /** Resolves when the first receive-pack request arrives. */
  readonly reached: Promise<void>;
  /** Receive-pack requests seen while armed. */
  attempts(): number;
  /** Answer the held request, and every later one while armed, with a 500. */
  fail(): void;
  /** Disarm; later pushes go through. */
  clear(): void;
}

export interface GitFront {
  readonly url: string;
  readonly requests: readonly GitHttpRequest[];
  holdPushes(): PushHold;
  stop(): void;
}

const isReceivePack = (url: URL): boolean =>
  url.pathname.endsWith('/git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack';

interface Hold {
  count: number;
  readonly reached: () => void;
  readonly gate: Promise<void>;
}

/**
 * D91: the fake forge as the runner sees it. Git paths go to `git http-backend` and need the minted token as Basic
 * auth; every other path is proxied to the fake forge (the API's GitHub calls).
 */
export function startGitFront(forgeUrl: string, reposRoot: string, token: () => string): GitFront {
  const git = createGitHttp(reposRoot, { username: 'x-access-token', password: token });
  let hold: Hold | null = null;
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    idleTimeout: 60,   // a held push waits for the test; Bun's default 10 s would drop it
    async fetch(req) {
      const url = new URL(req.url);
      const armed = hold;
      if (armed && isReceivePack(url)) {
        armed.count += 1;
        armed.reached();
        await armed.gate;
        return new Response('held by the test', { status: 500 });
      }
      const answered = await git.handle(req);
      if (answered) return answered;
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await req.arrayBuffer();
      return fetch(`${forgeUrl}${url.pathname}${url.search}`, { method: req.method, headers: req.headers, body });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests: git.requests,
    holdPushes() {
      let reached: () => void = () => undefined;
      let open: () => void = () => undefined;
      const reachedPromise = new Promise<void>((resolve) => { reached = resolve; });
      const state: Hold = { count: 0, reached: () => reached(), gate: new Promise<void>((resolve) => { open = resolve; }) };
      hold = state;
      return {
        reached: reachedPromise,
        attempts: () => state.count,
        fail: () => open(),
        clear: () => {
          if (hold === state) hold = null;
          open();
        },
      };
    },
    stop: () => { server.stop(true); },
  };
}
