/**
 * SSR-friendly fetch of the caller's project role and management rights.
 *
 * Used by pages that only need to gate UI controls (ticket detail, labels,
 * board) — they do not need the full paginated member list, so calling
 * `useProjectMembers().load()` would round-trip the whole members page
 * AND cause a flash of controls popping in on hydration.
 *
 * `useAsyncData` runs on the server during SSR and on the client during
 * hydration, so the returned refs are populated before any render and the
 * computed flags do not flicker.
 *
 * Reuses the existing `/projects/:slug/members` endpoint, which already
 * returns `canManage` and `viewerRole` alongside the paginated rows. We
 * request `size: 1` so the payload stays small.
 */
export function useProjectViewerRole(slug: string) {
  return useAsyncData<{ canManage: boolean; viewerRole: string | null }>(
    `project-viewer-role-${slug}`,
    async () => {
      const { $api } = useApi()
      const res = await $api.get<{
        canManage?: boolean
        viewerRole?: string | null
      }>(`/projects/${encodeURIComponent(slug)}/members`, { query: { size: '1' } })
      return {
        canManage: res.canManage === true,
        viewerRole: res.viewerRole ?? null,
      }
    },
    { default: () => ({ canManage: false, viewerRole: null }) },
  )
}
