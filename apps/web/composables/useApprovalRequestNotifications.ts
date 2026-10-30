import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { useApprovalInbox } from '~/composables/useApprovalInbox'
import { inboxHref, requestKeyLabel, viewerActions } from '~/lib/approval-requests'
import type { ApprovalRequestCounts, ApprovalRequestSummary } from '~/lib/approval-requests'

/** One toast on screen, plus the browser notification it may have beside it. */
interface ActiveNotice {
  row: ApprovalRequestSummary
  toastId: string
  browser?: Notification
}

/**
 * P3b US-005: approval toasts on the approval engine.
 *
 * The engine's inbox is the one place a held write waits, so the notices read the same list the
 * Pending tab lists (`GET /approvals?status=pending`, one page of 100) instead of re-deriving
 * permissions per scope:
 *
 * - **The counts snapshot is the gate.** A refresh with `total: 0` reads nothing at all; the caller
 *   hands in the snapshot it already loaded for the badge (US-006), so the two agree.
 * - **The row decides who may answer it.** `viewerActions` is the same rule the inbox rows use: an
 *   own ask in `human` mode is cancellable but not decidable, so it raises no toast. The badge may
 *   count it (7a's rule) — a notice would only offer a control the API refuses.
 * - **Only news is announced.** Per user and per request, once. A repeated refresh, a dismissal or a
 *   `decided()` keeps it quiet, and a refresh that no longer lists it closes its toast.
 * - **A failed refresh changes nothing.** The engine list can refuse or fail transiently; the toasts
 *   on screen stay until a successful refresh says otherwise.
 *
 * Delivery is browser-only and optional (`koda-approval-notifications-<userId>`), the API stays the
 * authority on membership and decision rights.
 */
export function useApprovalRequestNotifications(counts: Ref<ApprovalRequestCounts | null>) {
  const inbox = useApprovalInbox()
  const auth = useAuth()
  const { t, te } = useI18n()
  const toast = useAppToast()
  // Nuxt state is request-scoped during SSR and shared by every caller in this tab: per user, the
  // requests already announced. An entry alone keeps a request quiet — a dismissal is remembered.
  const announced = useState<Record<string, Record<string, number>>>(
    'approval-request-notifications-announced',
    () => ({}),
  )
  const enabled = ref(false)
  const supported = ref(false)
  const active = new Map<string, ActiveNotice>()
  const closed = new Set<string>()
  let mounted = false
  let generation = 0

  const toastId = (id: string): string => `approval-request-${auth.user.value?.id}-${id}`
  const preferenceKey = (): string => `koda-approval-notifications-${auth.user.value?.id}`

  /** The words for a request's permission key (`approvals.keys.*` when the locale has them). */
  const label = (row: ApprovalRequestSummary): string => requestKeyLabel(t, te, row.permissionKey)

  /** A request the engine has already denied on time is not news, whatever the list still says. */
  const expired = (row: ApprovalRequestSummary): boolean =>
    row.expiresAt !== null && Date.parse(row.expiresAt) <= Date.now()

  function dismiss(id: string): void {
    const notice = active.get(id)
    if (!notice) return
    notice.browser?.close()
    active.delete(id)
    toast.dismiss?.(notice.toastId)
  }

  function render(id: string): void {
    const notice = active.get(id)
    if (!notice) return
    toast(t('notifications.kinds.approval_request', { key: label(notice.row) }), {
      id: notice.toastId,
      duration: Infinity,
      action: {
        label: t('approvals.inbox.title'),
        onClick: () => {
          dismiss(id)
          void navigateTo(inboxHref(null, id))
        },
      },
      onDismiss: () => {
        if (active.get(id) === notice) dismiss(id)
      },
    })
  }

  /**
   * The optional browser notification, beside the in-app toast. Only a hidden tab gets one — a visible
   * tab already shows the toast — and a browser that exposes `Notification` but refuses to construct
   * one (mobile) simply skips it.
   */
  function deliverBrowser(notice: ActiveNotice): void {
    if (!enabled.value || !supported.value) return
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') return
    if (Notification.permission !== 'granted') return
    try {
      const browser = new Notification(t('notifications.kinds.approval_request', { key: label(notice.row) }), { tag: notice.toastId })
      browser.onclick = () => {
        window.focus()
        dismiss(notice.row.id)
        void navigateTo(inboxHref(null, notice.row.id))
      }
      notice.browser = browser
    } catch {
      // Intentional: the in-app toast is the notification of record.
    }
  }

  function notify(row: ApprovalRequestSummary): void {
    const userId = auth.user.value?.id
    if (!mounted || !userId || closed.has(row.id) || expired(row)) return
    if (!viewerActions(row, userId).decide) return
    const current = active.get(row.id)
    if (current) {
      current.row = row
      return
    }
    const history = announced.value[userId] ?? (announced.value[userId] = {})
    // Announced once per user and request: a dismissal is remembered, so it is never raised again.
    if (history[row.id] !== undefined) return
    history[row.id] = Date.now()
    const notice: ActiveNotice = { row, toastId: toastId(row.id) }
    active.set(row.id, notice)
    render(row.id)
    deliverBrowser(notice)
  }

  /**
   * One poll: the pending page, then reconcile. Anything the list no longer holds closes. A failed or
   * refused list keeps every toast and shows nothing — a flaky poll must not empty the screen, and the
   * next poll retries.
   */
  async function refresh(): Promise<void> {
    const token = ++generation
    const userId = auth.user.value?.id
    // Permissions P1 US-011: the account is its id, so a same-id role change never invalidates a refresh.
    const current = (): boolean => mounted && generation === token && auth.user.value?.id === userId
    const snapshot = counts.value
    if (!snapshot || snapshot.total <= 0 || !userId || !current()) return
    // Bound the retained announce history: a settled request can never become pending again.
    const history = announced.value[userId]
    if (history) {
      for (const [id, at] of Object.entries(history)) {
        if (at < Date.now() - 86400000 && !active.has(id)) delete history[id]
      }
    }
    let listed: ApprovalRequestSummary[]
    try {
      listed = (await inbox.list({ tab: 'pending' })).records
    } catch {
      // Intentional: a refused or failed list leaves the notices on screen and the next poll retries.
      return
    }
    if (!current()) return
    const pending = new Set<string>()
    for (const row of listed) {
      if (row.status !== 'pending') continue
      pending.add(row.id)
      notify(row)
    }
    for (const id of [...active.keys()]) {
      if (!pending.has(id)) dismiss(id)
    }
  }

  /** A request answered elsewhere (the inbox, a live event) takes its toast with it. */
  function decided(id: string): void {
    generation += 1
    closed.add(id)
    dismiss(id)
  }

  async function toggleBrowserNotifications(): Promise<void> {
    if (!mounted || !supported.value) return
    const userId = auth.user.value?.id
    const permission = enabled.value ? Notification.permission : await Notification.requestPermission()
    if (!mounted || auth.user.value?.id !== userId) return
    enabled.value = !enabled.value && permission === 'granted'
    try {
      localStorage.setItem(preferenceKey(), String(enabled.value))
    } catch {
      // Intentional: storage is optional (private mode), the choice still holds for this tab.
    }
  }

  onMounted(() => {
    mounted = true
    supported.value = typeof Notification !== 'undefined'
    try {
      enabled.value = supported.value && Notification.permission === 'granted' && localStorage.getItem(preferenceKey()) === 'true'
    } catch {
      // Intentional: unreadable storage means the preference defaults to opt-out.
    }
  })
  // The identity is the user id: a real account change closes every toast and forgets the preference.
  watch(() => auth.user.value?.id ?? null, () => {
    generation += 1
    for (const id of [...active.keys()]) dismiss(id)
    enabled.value = false
    closed.clear()
  })
  onBeforeUnmount(() => {
    mounted = false
    generation += 1
    for (const id of [...active.keys()]) dismiss(id)
  })

  return { refresh, decided, enabled, supported, toggleBrowserNotifications }
}
