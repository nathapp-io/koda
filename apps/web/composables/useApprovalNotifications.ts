import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Ref } from 'vue'
import { extractErrorStatus } from '~/composables/useApi'
import { approvalRoot } from '~/composables/useFleetApprovals'
import { apiPath } from '~/lib/api-path'
import { bashPayload, canDecide, commandPreview, countdownText, inboxPath, secondsLeft } from '~/lib/fleet-approvals'
import type { ApprovalBase, ApprovalViewer } from '~/lib/fleet-approvals'
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
    if (auth.user.value?.role === 'ADMIN') {
      await scan({ kind: 'admin' }, { kind: 'admin' }, current)
      return
    }
    for (const project of snapshot.projects) {
      if (!current()) return
      if (project.pending === 0) continue
      // Unlike the global account role, this endpoint describes the caller's project membership.
      try {
        const member = await $api.get<{ viewerRole?: string | null; canManage?: boolean }>(apiPath`/projects/${project.slug}/members`, { query: { size: '1' } })
        if (!current()) return
        const viewer: ApprovalViewer = { kind: 'project', canManage: member.canManage === true, canWork: ['ADMIN', 'DEVELOPER'].includes(member.viewerRole ?? '') }
        for (const [id, entry] of active) {
          if (entry.base.kind === 'project' && entry.base.slug === project.slug && !canDecide(entry.row, viewer)) dismiss(id)
        }
        if (viewer.canManage || viewer.canWork) await scan({ kind: 'project', slug: project.slug }, viewer, current)
      } catch (error) {
        if (!current()) return
        const code = error && typeof error === 'object' ? (error as { code?: number; statusCode?: number }).code ?? (error as { statusCode?: number }).statusCode : undefined
        const status = extractErrorStatus(error) ?? code
        if (status === 401 || status === 403 || status === 404) {
          for (const [id, entry] of active) {
            if (entry.base.kind === 'project' && entry.base.slug === project.slug) dismiss(id)
          }
        }
        // A membership may have disappeared since the count snapshot; continue with other projects.
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
