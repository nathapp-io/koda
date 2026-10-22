import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { extractErrorStatus } from '~/composables/useApi'
import { approvalRoot } from '~/composables/useFleetApprovals'
import { bashPayload, canDecide, commandPreview, countdownText, inboxPath, secondsLeft } from '~/lib/fleet-approvals'
import type { ApprovalBase, ApprovalViewer } from '~/lib/fleet-approvals'
import { permissionSet } from '~/lib/permissions'
import type { PermissionSet } from '~/lib/permissions'
import type { ApprovalCountsDto, FleetApprovalDto, FleetPage } from '~/lib/fleet-types'

/** Browser-only delivery; the API remains the authority on membership and decision rights. */
export function useApprovalNotifications(counts: Ref<ApprovalCountsDto | null>) {
  const { $api } = useApi()
  const auth = useAuth()
  const { t } = useI18n()
  const toast = useAppToast()
  // Nuxt state is request-scoped during SSR and survives layout navigation in this tab.
  const seen = useState<Record<string, Record<string, { at: number; dismissed: boolean }>>>('approval-notifications-seen', () => ({}))
  const enabled = ref(false)
  const supported = ref(false)
  const active = new Map<string, { row: FleetApprovalDto; base: ApprovalBase; toastId: string; browser?: Notification }>()
  const closed = new Set<string>()
  let mounted = false
  let generation = 0
  let timer: ReturnType<typeof setInterval> | null = null
  const toastId = (id: string): string => `fleet-approval-${auth.user.value?.id}-${id}`
  const preferenceKey = (): string => `koda-approval-notifications-${auth.user.value?.id}`

  function markDismissed(id: string): void {
    const userId = auth.user.value?.id
    const previous = userId ? seen.value[userId]?.[id] : undefined
    if (previous) previous.dismissed = true
  }

  function dismiss(id: string): void {
    const notification = active.get(id)
    if (!notification) return
    notification.browser?.close()
    active.delete(id)
    toast.dismiss?.(notification.toastId)
  }

  function description(row: FleetApprovalDto): string {
    const bash = bashPayload(row)
    const remaining = secondsLeft(row.expiresAt, new Date())
    return [
      bash ? commandPreview(bash) : t(`fleet.approvals.type.${row.type}`),
      row.jobId ? t('fleet.approvals.notifications.job', { job: row.jobId }) : '',
      remaining === null ? '' : t('fleet.approvals.notifications.remaining', { time: countdownText(remaining) }),
    ].filter(Boolean).join(' · ')
  }

  function render(id: string): void {
    const notification = active.get(id)
    if (!notification) return
    const { row, base } = notification
    if (secondsLeft(row.expiresAt, new Date()) === 0) {
      closed.add(id)
      dismiss(id)
      return
    }
    toast(t('fleet.approvals.notifications.title'), {
      id: notification.toastId,
      duration: Infinity,
      description: description(row),
      action: {
        label: t('fleet.approvals.notifications.review'),
        onClick: () => { markDismissed(id); dismiss(id); void navigateTo(inboxPath(base, id)) },
      },
      onDismiss: () => { if (active.get(id) === notification) { markDismissed(id); dismiss(id) } },
    })
  }

  function notify(row: FleetApprovalDto, base: ApprovalBase, viewer: ApprovalViewer): void {
    const userId = auth.user.value?.id
    if (!mounted || !userId || closed.has(row.id) || !canDecide(row, viewer) || secondsLeft(row.expiresAt, new Date()) === 0) return
    const current = active.get(row.id)
    if (current) {
      current.row = row
      return
    }
    const history = seen.value[userId] ?? (seen.value[userId] = {})
    const previous = history[row.id]
    if (previous?.dismissed) return
    history[row.id] = { at: Date.now(), dismissed: false }
    const entry: { row: FleetApprovalDto; base: ApprovalBase; toastId: string; browser?: Notification } = { row, base, toastId: toastId(row.id) }
    active.set(row.id, entry)
    render(row.id)
    if (!previous && enabled.value && supported.value && Notification.permission === 'granted' && document.visibilityState === 'hidden') {
      try {
        const browser = new Notification(t('fleet.approvals.notifications.title'), { body: description(row), tag: entry.toastId })
        browser.onclick = () => { window.focus(); markDismissed(row.id); dismiss(row.id); void navigateTo(inboxPath(base, row.id)) }
        entry.browser = browser
      } catch {
        // Some browsers expose Notification but disallow constructing one (e.g. mobile).
      }
    }
  }

  async function scan(base: ApprovalBase, viewer: ApprovalViewer, current: () => boolean): Promise<void> {
    const pending = new Set<string>()
    let page = 1
    while (current()) {
      const result = await $api.get<FleetPage<FleetApprovalDto>>(approvalRoot(base), {
        query: { status: 'pending', size: '100', ...(page > 1 ? { current: String(page) } : {}) },
      })
      if (!current()) return
      for (const row of result.records ?? []) {
        if (row.status !== 'pending') continue
        pending.add(row.id)
        notify(row, base, viewer)
      }
      if (!result.hasNext) break
      page += 1
    }
    if (!current()) return
    for (const [id, entry] of active) {
      if (approvalRoot(entry.base) === approvalRoot(base) && !pending.has(id)) dismiss(id)
    }
  }

  /**
   * A 401/403/404 on one scope means that inbox is no longer this caller's, so its alerts close. Anything else is
   * transient and leaves them alone: a flaky poll must not empty the screen.
   */
  function dismissScopeOnRefusal(error: unknown, match: (base: ApprovalBase) => boolean): void {
    const code = error && typeof error === 'object'
      ? (error as { code?: number; statusCode?: number }).code ?? (error as { statusCode?: number }).statusCode
      : undefined
    const status = extractErrorStatus(error) ?? code
    if (status !== 401 && status !== 403 && status !== 404) return
    for (const [id, entry] of [...active]) {
      if (match(entry.base)) dismiss(id)
    }
  }

  /**
   * Permissions P1 US-009: the caller's effective keys for one scope, read directly — `refresh()` runs outside setup,
   * so it cannot use `useAsyncData`. `{ error }` means the read failed: the caller then scans nothing for that scope.
   */
  async function permissionKeys(project: string | null): Promise<{ keys: PermissionSet } | { error: unknown }> {
    try {
      const response = project === null
        ? await $api.get<{ keys?: string[] }>('/me/permissions')
        : await $api.get<{ keys?: string[] }>('/me/permissions', { query: { project } })
      return { keys: permissionSet(Array.isArray(response?.keys) ? response.keys : []) }
    } catch (error) {
      return { error }
    }
  }

  /** The decision rights one project's key set carries; each approval kind has its own decide route. */
  const projectViewer = (keys: PermissionSet): ApprovalViewer => ({
    kind: 'project',
    userId: auth.user.value?.id ?? null,
    canDecideBudget: keys.has('fleet.approval.decide.budget'),
    canDecideBash: keys.has('fleet.approval.decide.bash'),
  })

  const adminViewer = (keys: PermissionSet): ApprovalViewer => ({
    kind: 'admin',
    userId: auth.user.value?.id ?? null,
    canDecideBudget: keys.has('fleet.approval.decide.budget'),
    canDecideBash: keys.has('fleet.approval.decide.bash'),
  })

  async function refresh(): Promise<void> {
    const token = ++generation
    const userId = auth.user.value?.id
    const role = auth.user.value?.role
    const snapshot = counts.value
    const current = (): boolean => mounted && generation === token && auth.user.value?.id === userId && auth.user.value?.role === role
    if (!snapshot || !userId || !current()) return
    // Bound retained dedupe history; terminal approvals cannot become pending again.
    const history = seen.value[userId]
    if (history) for (const [id, entry] of Object.entries(history)) {
      if (entry.at < Date.now() - 86400000 && !active.has(id)) delete history[id]
    }
    // The global keys decide which inbox this account may read at all. Nothing is scanned until they answer, and a
    // failed read scans nothing: a guess here would deliver a notification for an approval this caller cannot decide.
    const global = await permissionKeys(null)
    if (!current() || 'error' in global) return
    if (global.keys.has('fleet.approval.read')) {
      const viewer = adminViewer(global.keys)
      // A refreshed key set can withdraw the power to answer an ask already on screen (the read key alone is not a
      // decision): close those first, exactly as the project branch does, so no alert sits there unanswerable.
      for (const [id, entry] of [...active]) {
        if (entry.base.kind === 'admin' && !canDecide(entry.row, viewer)) dismiss(id)
      }
      try {
        await scan({ kind: 'admin' }, viewer, current)
      } catch (error) {
        if (!current()) return
        // A refused admin inbox closes its alerts and ends this refresh; there is no other scope to continue with.
        dismissScopeOnRefusal(error, (base) => base.kind === 'admin')
      }
      return
    }
    // Without the global read key this refresh cannot re-verify the admin inbox's alerts, so they close: a notice
    // the caller can no longer act on is worse than none. Project alerts are re-checked below, one project at a time.
    for (const [id, entry] of [...active]) {
      if (entry.base.kind === 'admin') dismiss(id)
    }
    for (const project of snapshot.projects) {
      if (!current()) return
      if (project.pending === 0) continue
      // The project's own key set replaces the membership read: only a decide key makes its inbox readable.
      const result = await permissionKeys(project.slug)
      if (!current()) return
      if ('error' in result) {
        // A project may have disappeared since the count snapshot; continue with the others.
        dismissScopeOnRefusal(result.error, (base) => base.kind === 'project' && base.slug === project.slug)
        continue
      }
      const viewer = projectViewer(result.keys)
      for (const [id, entry] of [...active]) {
        if (entry.base.kind === 'project' && entry.base.slug === project.slug && !canDecide(entry.row, viewer)) dismiss(id)
      }
      if (!viewer.canDecideBudget && !viewer.canDecideBash) continue
      try {
        await scan({ kind: 'project', slug: project.slug }, viewer, current)
      } catch (error) {
        if (!current()) return
        // One project's inbox can refuse this caller (a decide key without the read key) or be gone: the other
        // projects must still be scanned, so this failure stays inside this project.
        dismissScopeOnRefusal(error, (base) => base.kind === 'project' && base.slug === project.slug)
      }
    }
    if (!current()) return
    for (const [id, entry] of active) {
      const base = entry.base
      if (base.kind === 'project' && !snapshot.projects.some(project => project.slug === base.slug && project.pending > 0)) dismiss(id)
    }
  }

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
    try { localStorage.setItem(preferenceKey(), String(enabled.value)) } catch { /* Storage is optional. */ }
  }

  onMounted(() => {
    mounted = true
    supported.value = typeof Notification !== 'undefined'
    try { enabled.value = supported.value && Notification.permission === 'granted' && localStorage.getItem(preferenceKey()) === 'true' } catch { /* Defaults to opt-out. */ }
    timer = setInterval(() => { for (const id of active.keys()) render(id) }, 1000)
  })
  watch(() => [auth.user.value?.id, auth.user.value?.role] as const, (identity, previous) => {
    generation += 1
    for (const id of active.keys()) dismiss(id)
    if (identity[0] !== previous[0]) enabled.value = false
    closed.clear()
  })
  onBeforeUnmount(() => {
    mounted = false
    generation += 1
    if (timer !== null) clearInterval(timer)
    for (const id of active.keys()) dismiss(id)
  })
  return { refresh, decided, enabled, supported, toggleBrowserNotifications }
}
