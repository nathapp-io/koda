/**
 * Plan D282: behaves like nax's webhook plugin for one bash ask (webhook.ts:255-277, 451-573): POSTs a real-shaped,
 * signed InteractionRequest to the profile's interaction url, serves its own loopback callback, verifies the answer's
 * signature, and records what it got (or that it timed out / its POST failed) in <outDir>/fake-ask.json.
 */
import { createHmac } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface FakeProfile {
  outputDir?: string;
  execution?: { approvalTimeout?: number };
  interaction?: { plugin?: string; config?: { url?: string; secret?: string } };
}

const sign = (secret: string, body: string): string => createHmac('sha256', secret).update(body).digest('hex');

export async function askOnce(profile: FakeProfile, outDir: string): Promise<void> {
  const record = (result: object): void => writeFileSync(join(outDir, 'fake-ask.json'), `${JSON.stringify(result)}\n`);
  const url = profile.interaction?.config?.url;
  const secret = profile.interaction?.config?.secret;
  if (profile.interaction?.plugin !== 'webhook' || !url || !secret) return record({ skipped: 'no webhook in profile' });
  const timeout = profile.execution?.approvalTimeout ?? 600_000;
  const id = `ask-${Math.random().toString(16).slice(2, 10).padEnd(8, '0')}`;

  let settle: (answer: object) => void = () => undefined;
  const answered = new Promise<object>((resolve) => { settle = resolve; });
  const callback = Bun.serve({
    hostname: '127.0.0.1', port: 0,
    fetch: async (req) => {
      const body = await req.text();
      if (req.headers.get('x-nax-signature') !== sign(secret, body)) return new Response('Unauthorized', { status: 401 });
      settle(JSON.parse(body) as object);
      return new Response('OK');
    },
  });
  try {
    const request = {
      id, type: 'choose', featureName: 'fa', storyId: 'US-001', stage: 'execution', summary: 'Bash - approval required',
      detail: '```\nbun run test\n```\nrequest: Bash command=bun run test\nruns in: /work/repo\nreason:  matched ask rule\nstage:   execution',
      options: [{ key: 'allow', label: 'Allow once' }, { key: 'allow-remember', label: 'Allow + remember' }, { key: 'deny', label: 'Deny' }],
      timeout, fallback: 'abort', createdAt: Date.now(), metadata: { approvalPrompt: true },
      callbackUrl: `http://127.0.0.1:${callback.port}/nax/interact/${id}`,
    };
    const body = JSON.stringify(request);
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-nax-signature': sign(secret, body) }, body })
      .catch(() => null);
    if (!res || !res.ok) return record({ postFailed: res?.status ?? 'unreachable' });   // nax: deny / unavailable (A7)
    const answer = await Promise.race([answered, Bun.sleep(timeout).then(() => ({ timeout: true }))]);
    record(answer);
  } finally {
    callback.stop(true);
  }
}
