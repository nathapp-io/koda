import { verifyNax } from './nax-callback';

/** Spec §4.2: nax's webhook bodies are small; anything bigger is not an ask. */
export const MAX_ASK_BODY_BYTES = 64 * 1024;

export interface ReceiverOptions {
  readonly port: number;
  readonly secret: string;
  /** Called with a verified, parsed body; returns the HTTP status for nax. Must answer quickly (nax POST timeout 30 s). */
  readonly onRequest: (body: unknown) => Promise<number>;
}

/** Spec §4.1: one loopback receiver per non-raw job; nax's webhook plugin POSTs its asks to `/ask`. */
export class ApprovalReceiver {
  private constructor(private readonly server: ReturnType<typeof Bun.serve>) {}

  /** Throws when the port is taken (a READOPT re-bind reports that; plan D273). */
  static start(options: ReceiverOptions): ApprovalReceiver {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: options.port,
      maxRequestBodySize: MAX_ASK_BODY_BYTES,
      fetch: (req) => ApprovalReceiver.handle(req, options),
    });
    return new ApprovalReceiver(server);
  }

  get port(): number {
    return this.server.port ?? 0;
  }

  stop(): void {
    this.server.stop(true);
  }

  private static async handle(req: Request, options: ReceiverOptions): Promise<Response> {
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/ask') return new Response('Not Found', { status: 404 });
    if (Number(req.headers.get('content-length') ?? '0') > MAX_ASK_BODY_BYTES) return new Response('Payload Too Large', { status: 413 });
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.byteLength > MAX_ASK_BODY_BYTES) return new Response('Payload Too Large', { status: 413 });
    if (!verifyNax(options.secret, raw, req.headers.get('x-nax-signature'))) return new Response('Unauthorized', { status: 401 });
    let body: unknown;
    try {
      body = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
    // Backstop only: onRequest logs its own failures (review ENH-1); this guards a logging-side throw.
    const status = await options.onRequest(body).catch(() => 500);
    return new Response(status === 200 ? 'OK' : 'Rejected', { status });
  }
}
