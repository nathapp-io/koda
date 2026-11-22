import type { ThreadAcpOffer } from '@nathapp/fleet-protocol';
import type { AcpAgentProbe } from './acp-agent-probe';

/**
 * US-004: how long a confirmed offer survives a transient probe failure. Three default probe intervals
 * (`capabilityProbeMs`), so an agent that misses one probe stays offered until the next ones answer again; after that
 * the offer is dropped and the failure is reported as it is.
 */
export const ACP_LAST_GOOD_MAX_AGE_MS = 1_800_000;

export interface AcpOfferMemoryOptions {
  /** Production: the current time; injectable so a spec reaches the age boundary without waiting. */
  readonly now?: () => Date;
  /** Defaults to `ACP_LAST_GOOD_MAX_AGE_MS`. */
  readonly maxAgeMs?: number;
}

const parseCheckedAt = (offer: ThreadAcpOffer): number | null => {
  if (offer.checkedAt === undefined) return null;
  const time = Date.parse(offer.checkedAt);
  return Number.isNaN(time) ? null : time;
};

/**
 * US-004: a probe decorator that remembers, per agent, the last offer that was both launchable and logged in. A probe
 * miss is usually transient (an agent timeout, a locked keychain), and reporting it as `loggedIn: null` would drop the
 * agent from `threadBackends.acp` until the next probe; instead the remembered offer is reported with the new
 * `lastError`, keeping its own `checkedAt` so the form still shows when the agent was last confirmed.
 *
 * The memory is in-process: the first probe after a runner restart has no remembered offer.
 */
export function createAcpOfferMemory(probe: AcpAgentProbe, options: AcpOfferMemoryOptions = {}): AcpAgentProbe {
  const now = options.now ?? (() => new Date());
  const maxAgeMs = options.maxAgeMs ?? ACP_LAST_GOOD_MAX_AGE_MS;
  const remembered = new Map<string, ThreadAcpOffer>();

  return async () => {
    const offers = await probe();
    const at = now().getTime();
    return offers.map((offer): ThreadAcpOffer => {
      if (offer.launchable && offer.loggedIn === true) {
        // A remembered offer without a parseable `checkedAt` could never be aged out, so it is never kept.
        if (parseCheckedAt(offer) === null) remembered.delete(offer.agent);
        else remembered.set(offer.agent, offer);
        return offer;
      }
      if (offer.lastError !== undefined) {
        const kept = remembered.get(offer.agent);
        const confirmedAt = kept === undefined ? null : parseCheckedAt(kept);
        if (kept !== undefined && confirmedAt !== null && at - confirmedAt <= maxAgeMs) {
          // The remembered offer keeps its own `checkedAt`: it is when the agent was confirmed, not when it failed.
          return { ...kept, lastError: offer.lastError };
        }
      }
      remembered.delete(offer.agent);
      return offer;
    });
  };
}
