import { computed, onMounted, watch } from 'vue'

/**
 * The browser-notification preference for approval notices, shared by the settings page and the
 * notices that deliver them.
 *
 * It is one per tab (`useState`), not one per caller: the settings page turns the preference on and
 * the header's notices read the same value without a reload, and a second caller never re-asks the
 * browser. The pieces:
 *
 * - **The storage is optional.** `koda-approval-notifications-<userId>` remembers the choice, but a
 *   browser that refuses storage (private mode) still toggles for this tab.
 * - **Granted means granted.** Enabling asks the browser; a refusal leaves the preference off and
 *   records it as `permissionDenied` so the settings page can explain it. `Notification.permission`
 *   is not reactive, so the flag is stored rather than computed.
 * - **The account is the identity.** A different user id forgets the preference: the key is per user.
 * - **SSR-safe.** Without a `Notification` API nothing is supported, nothing is stored, and the
 *   settings page renders the unsupported copy instead of a control.
 *
 * Approval authorization stays server-side; this only decides whether the browser may raise a notice.
 */
export interface BrowserApprovalNotificationPreferenceState {
  /** At least one caller has mounted, so the storage read happened. */
  mounted: boolean
  enabled: boolean
  supported: boolean
  /** The browser is blocking notifications for this site; not a computed over a non-reactive API. */
  permissionDenied: boolean
}

export function useBrowserApprovalNotificationPreference() {
  const auth = useAuth()
  // Nuxt state is request-scoped during SSR and shared by every caller in this tab.
  const state = useState<BrowserApprovalNotificationPreferenceState>(
    'browser-approval-notification-preference',
    () => ({ mounted: false, enabled: false, supported: false, permissionDenied: false }),
  )

  const supported = computed(() => state.value.supported)
  const enabled = computed(() => state.value.enabled)
  const permissionDenied = computed(() => state.value.permissionDenied)

  const preferenceKey = (): string => `koda-approval-notifications-${auth.user.value?.id}`

  /** `Notification.permission` only reads meaningfully after the API exists, and it is not reactive. */
  function readPermission(): void {
    state.value.permissionDenied = typeof Notification !== 'undefined' && Notification.permission === 'denied'
  }

  /** Turn the preference on (asking the browser) or off. A refusal leaves it off. */
  async function toggle(): Promise<void> {
    if (!state.value.mounted || !state.value.supported) return
    const userId = auth.user.value?.id ?? null
    // Enabling may wait on the user; the account can change while the prompt is open.
    const current = (): boolean => state.value.mounted && (auth.user.value?.id ?? null) === userId
    const granted = state.value.enabled
      ? Notification.permission === 'granted'
      : (await Notification.requestPermission()) === 'granted'
    if (!current()) return
    state.value.enabled = !state.value.enabled && granted
    readPermission()
    try {
      localStorage.setItem(preferenceKey(), String(state.value.enabled))
    } catch {
      // Intentional: storage is optional (private mode), the choice still holds for this tab.
    }
  }

  onMounted(() => {
    // The storage read happens once per tab. A caller that mounts later (the badge after the settings
    // page, say) must not reread it: storage that refused the write holds nothing, and rereading would
    // silently turn this tab's own choice back off.
    if (state.value.mounted) return
    state.value.mounted = true
    state.value.supported = typeof Notification !== 'undefined'
    readPermission()
    try {
      state.value.enabled = state.value.supported
        && Notification.permission === 'granted'
        && localStorage.getItem(preferenceKey()) === 'true'
    } catch {
      // Intentional: unreadable storage means the preference defaults to opt-out.
    }
  })
  // The identity is the user id, and the stored key is per user: a real account change forgets it.
  watch(() => auth.user.value?.id ?? null, () => {
    state.value.enabled = false
  })

  return { supported, enabled, permissionDenied, toggle }
}
