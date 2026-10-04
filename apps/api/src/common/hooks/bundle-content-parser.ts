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

/** Fleet log uploads (S2a §2.2): raw stream; LogUploadService counts the bytes itself (plan D312). */
export function registerLogContentParser(fastify: FastifyLike): void {
  fastify.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
}
