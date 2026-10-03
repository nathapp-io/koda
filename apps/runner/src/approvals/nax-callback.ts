import { createHmac, timingSafeEqual } from 'node:crypto';

/** nax's answer schema (webhook.ts:56-62): `respondedAt` is a number (epoch ms), never an ISO string. */
export interface NaxAnswer { requestId: string; action: 'choose' | 'skip' | 'approve'; value?: string; respondedBy: string; respondedAt: number }

// Plan D274: nax does not URL-encode ids (`ix-<storyId>-size-gate` carries a story id), so accept any id without / ? # or whitespace.
const CALLBACK = /^http:\/\/127\.0\.0\.1:(\d{1,5})\/nax\/interact\/([^/?#\s]{1,200})$/;
const DEFAULT_TIMEOUT_MS = 10_000;

export function signNax(secret: string, body: string | Uint8Array): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

export function verifyNax(secret: string, body: Uint8Array, header: string | null): boolean {
  if (header === null || !/^[0-9a-f]{64}$/i.test(header)) return false;
  const expected = createHmac('sha256', secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(header, 'hex'));
}

/** Plan D274: the runner only ever POSTs to nax's own loopback callback for this exact ask. */
export function callbackUrlFor(request: { id: unknown; callbackUrl: unknown }): string | null {
  if (typeof request.id !== 'string' || typeof request.callbackUrl !== 'string') return null;
  const match = CALLBACK.exec(request.callbackUrl);
  if (!match || Number(match[1]) < 1 || Number(match[1]) > 65_535 || match[2] !== request.id) return null;
  return request.callbackUrl;
}

/** Spec §4.4: one signed POST with a 10 s deadline. No retry: a failed answer ends in nax's timeout deny. */
export async function postToNax(callbackUrl: string, secret: string, answer: NaxAnswer, opts: { timeoutMs?: number; fetch?: typeof fetch } = {}): Promise<{ ok: true } | { ok: false; detail: string }> {
  const body = JSON.stringify(answer);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await (opts.fetch ?? fetch)(callbackUrl, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-nax-signature': signNax(secret, body) }, body, signal: controller.signal,
    });
    return res.status === 200 ? { ok: true } : { ok: false, detail: `callback_failed:${res.status}` };
  } catch {
    return { ok: false, detail: controller.signal.aborted ? 'callback_failed:timeout' : 'callback_failed:error' };
  } finally {
    clearTimeout(timer);
  }
}
