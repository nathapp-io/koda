type Done = (err: Error | null, body?: unknown) => void;
type FastifyLike = { addContentTypeParser: (type: string, parser: (req: unknown, payload: unknown, done: Done) => void) => void };

/**
 * Fleet bundle uploads (spec §3.3, plan D12): pass the raw application/gzip stream to the
 * handler unbuffered. The size cap is enforced by the ArtifactStore while streaming; the
 * JSON raw-body hook only buffers application/json, so it never touches these bodies.
 */
export function registerBundleContentParser(fastify: FastifyLike): void {
  fastify.addContentTypeParser('application/gzip', (_req, payload, done) => done(null, payload));
}
