import { ref } from 'vue'
import type { Ref } from 'vue'
import { extractApiError } from '~/composables/useApi'
import { apiPath } from '~/lib/api-path'
import type { AgentChoice } from '~/lib/thread-create'
import type { ThreadAgent } from '~/lib/thread-types'

/** How long the runner list is re-read between attempts, and how many reads happen before giving up. */
export const AGENT_RECHECK_INTERVAL_MS = 10_000
export const AGENT_RECHECK_ATTEMPTS = 12

export interface AgentRecheckOptions {
  /** Wait between two runner-list reads. */
  intervalMs?: number
  /** Reads before the refresh stops on its own (a bound, not a deadline). */
  attempts?: number
}

export interface AgentRecheckHandle {
  /** Ask every runner the agent's probe names to probe it again, then refresh until a fresh result. */
  recheck: (agent: ThreadAgent) => Promise<void>
  /** The agent being re-checked, from the click until the refresh stops. */
  rechecking: Ref<ThreadAgent | null>
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * US-009: the Re-check of one not-ready agent, shared by both new-thread pages.
 *
 * The only other probe triggers are the runner's own 10-minute timer and a SIGHUP on its host, so a
 * person waiting on a form has to be able to ask for one. `recheck` posts the request for each runner
 * the agent's probe names, then re-reads the runner list until the probe reports a new `checkedAt`, the
 * agent becomes available, or the attempt bound is reached — whichever comes first.
 *
 * `reload` is the page's own non-destructive read of the runner list and `read` finds the agent's
 * current `AgentChoice` in it, so the composable never holds a copy of the data the form renders.
 * Both are called during page setup (never inside an async callback), because `useApi`, `useAppToast`
 * and `useI18n` need a component instance.
 *
 * A 202 (an approval policy covers `fleet.runner.update`) is treated like an accepted request: the same
 * toast, the same refreshes, no approval state of its own.
 */
export function useAgentRecheck(
  reload: () => Promise<void>,
  read: (agent: ThreadAgent) => AgentChoice | undefined,
  options: AgentRecheckOptions = {},
): AgentRecheckHandle {
  const { $api } = useApi()
  const toast = useAppToast()
  const { t } = useI18n()
  const { intervalMs = AGENT_RECHECK_INTERVAL_MS, attempts = AGENT_RECHECK_ATTEMPTS } = options
  const rechecking = ref<ThreadAgent | null>(null)

  /**
   * Re-reads the runner list until the agent's probe is worth showing differently. A reload that fails
   * stops the wait: the page surfaces its own load failure, and there is no fresh result coming.
   */
  async function refreshUntilSettled(agent: ThreadAgent, checkedBefore: string | null): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await wait(intervalMs)
      try {
        await reload()
      }
      catch {
        return
      }
      const choice = read(agent)
      if (choice?.available === true) return
      if ((choice?.probe?.checkedAt ?? null) !== checkedBefore) return
    }
  }

  async function recheck(agent: ThreadAgent): Promise<void> {
    const probe = read(agent)?.probe
    const checkedBefore = probe?.checkedAt ?? null
    // Set before the first request, so the button is disabled while the posts themselves are in flight.
    rechecking.value = agent
    try {
      for (const runnerId of probe?.runnerIds ?? []) {
        await $api.post(apiPath`/fleet/runners/${runnerId}/reprobe`)
      }
      toast.success(t('fleet.threads.new.agent.recheckRequested'))
      await refreshUntilSettled(agent, checkedBefore)
    }
    catch (error: unknown) {
      // A refused request (403 for a lost key, 404 for a runner that left) stops here: nothing was asked.
      toast.error(extractApiError(error))
    }
    finally {
      rechecking.value = null
    }
  }

  return { recheck, rechecking }
}
