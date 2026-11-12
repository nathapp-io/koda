import { expect, test } from '@jest/globals'
import { nextTick, ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'
import { enI18n, uiStubs } from '../helpers/fleet-harness'
import { formatDateTime } from '../../lib/format-date-time'

const date = '2026-11-10T14:07:45.657Z'
test.each(['en', 'zh'])('CommentThread renders semantic locale-formatted time (%s)', async (locale) => {
  const app = mountSfc(webFile('components', 'CommentThread.vue'), { props: { projectSlug: 'web', ticketRef: 'WEB-1' }, components: uiStubs, globals: { useApi: () => ({ $api: { get: async () => [{ id: 'c1', body: 'hello', type: 'GENERAL', createdAt: date }] } }), useI18n: () => ({ ...enI18n(), locale: ref(locale) }), useAppToast: () => ({ success: () => undefined, error: () => undefined }), useProjectMemberNames: () => ({ load: async () => undefined, nameOf: () => null }), useAsyncData: (_key: string, loader: () => Promise<unknown>) => ({ data: ref([{ id: 'c1', body: 'hello', type: 'GENERAL', createdAt: date }]), pending: ref(false), error: ref(null), refresh: loader }) } })
  const time = app.one('[data-testid="comment-time"]')
  expect(time?.tag).toBe('time')
  expect(time?.props.datetime).toBe(date)
  expect(time ? app.textOf(time) : '').toBe('')
  await nextTick()
  expect(time ? app.textOf(time) : '').toBe(formatDateTime(date, locale))
  app.unmount()
})
