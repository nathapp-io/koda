import type { EmbedderTool, EmbedderToolContext, EmbedderToolResult } from '@nathapp/nax-agent';
import type { KodaToolDescriptor } from '@nathapp/fleet-protocol';
import { ServerError } from '../../sync/http';

/** One proxied call: the job and epoch it belongs to, the provider's tool call and what the model sent. */
export interface KodaToolCallInput {
  jobId: string;
  leaseEpoch: number;
  name: string;
  toolCallId: string;
  input: unknown;
  signal?: AbortSignal;
}

/** What the server answered for one call (the shape `ServerClient.callKodaTool` resolves with). */
export interface KodaToolResult {
  content: string;
  isError: boolean;
}

/**
 * Fleet S5b US-006: what a proxy needs to reach the API. The daemon wires it to `ServerClient.callKodaTool`;
 * the tool is defined and executed on the server, and no credential of the runner or the user travels with it.
 */
export interface KodaToolCaller {
  call(args: KodaToolCallInput): Promise<KodaToolResult>;
}

export interface KodaToolProxyOptions {
  jobId: string;
  leaseEpoch: number;
  caller: KodaToolCaller;
}

/** The answer the model sees when the server could not be reached, or the call was aborted. Never re-sent. */
const UNAVAILABLE_NETWORK = 'koda tool unavailable: network error';

/**
 * One `EmbedderTool` per descriptor, in descriptor order. `run` makes exactly one call — the provider's
 * `toolCallId` and the turn's abort signal go with it, so the server's replay (`jobId`, `toolCallId`) sees the
 * same ids the transcript does. An HTTP refusal is reported with the server's own message; any other failure (a
 * network error, an abort, a programming fault) is the fixed network answer, and nothing is ever retried.
 */
export function buildKodaToolProxies(descriptors: readonly KodaToolDescriptor[], options: KodaToolProxyOptions): EmbedderTool[] {
  return descriptors.map((descriptor) => ({
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
    approval: 'never',
    async run(input: unknown, ctx: EmbedderToolContext): Promise<EmbedderToolResult> {
      try {
        return await options.caller.call({
          jobId: options.jobId,
          leaseEpoch: options.leaseEpoch,
          name: descriptor.name,
          toolCallId: ctx.toolCallId,
          input,
          signal: ctx.signal,
        });
      } catch (error) {
        if (error instanceof ServerError) return { content: `koda tool unavailable: ${error.message}`, isError: true };
        return { content: UNAVAILABLE_NETWORK, isError: true };
      }
    },
  }));
}
