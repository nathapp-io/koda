/**
 * Permissions P1 US-006: the web's view of the caller's effective permission keys.
 *
 * The API is the authority — a gate in the UI only hides or disables a control, and every refusal
 * still comes back as an error the caller surfaces with `extractApiError`. What this module adds is
 * the fail-closed default: a key the caller does not hold is not rendered.
 *
 * Two forms of "holding" a key, because the API grants both:
 * - `has(key)` — a row granting the key for every resource (`comment.update`).
 * - `hasOwn(key)` — the key for every row, or only for the rows the caller created
 *   (`comment.update.own`, stored as its own catalog entry).
 *
 * `has` never promotes an `.own` entry: a role that only allows acting on your own rows must not
 * unlock an action on anybody's row. `hasOwn` does promote it, because "I may act on mine" is the
 * whole question that control asks.
 */
export interface PermissionSet {
  /** Holds the key for every row. */
  has(key: string): boolean
  /** Holds the key for every row, or only for rows the caller created (`key.own`). */
  hasOwn(key: string): boolean
  /**
   * P3b US-001: "may decide an approval request of some kind" — `approval.decide`, or any narrowed
   * `approval.decide@<pattern>` key. `has('approval.decide')` answers false for a narrowed key, so
   * the nav, the palette and the badge ask this instead: they only need to know whether opening an
   * inbox can show the caller anything to decide.
   */
  mayDecide(): boolean
}

const OWN_SUFFIX = '.own'
const DECIDE_KEY = 'approval.decide'
const DECIDE_PREFIX = `${DECIDE_KEY}@`

/** The set of keys one `/me/permissions` answer listed. */
export function permissionSet(keys: readonly string[]): PermissionSet {
  const held = new Set(keys)
  return {
    has: (key: string): boolean => held.has(key),
    hasOwn: (key: string): boolean => held.has(key) || held.has(`${key}${OWN_SUFFIX}`),
    mayDecide: (): boolean => held.has(DECIDE_KEY) || keys.some((key) => key.startsWith(DECIDE_PREFIX)),
  }
}

/**
 * The fail-closed default: what a pending, failed or not-yet-asked for fetch exposes.
 *
 * Frozen on purpose. It is a constant every closed gate shares, and a frozen object is the one
 * object Vue never wraps in a reactive proxy — so `permissions.value` is this exact instance, and a
 * caller (or a test) can compare it by identity rather than by shape.
 */
export const EMPTY_PERMISSIONS: PermissionSet = Object.freeze({
  has: (): boolean => false,
  hasOwn: (): boolean => false,
  mayDecide: (): boolean => false,
})
