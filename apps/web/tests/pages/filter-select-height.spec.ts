import { describe, expect, test, jest } from '@jest/globals'
import { ref } from 'vue'
import { mountSfc, webFile } from '../helpers/mount-sfc'

const page = webFile('pages', '[project]', 'timeline.vue')

describe('timeline filter control height', () => {
  test('event type select uses the shared input-height classes', () => {
    const mounted = mountSfc(page, {
      globals: {
        definePageMeta: () => undefined,
        useRoute: () => ({ params: { project: 'acme' } }),
        useI18n: () => ({ locale: ref('en'), t: (key: string) => key, te: () => false }),
        useAppToast: () => ({ error: jest.fn() }),
        useProjectMemberNames: () => ({ nameOf: () => undefined, load: async () => undefined }),
        useTimelineEvents: () => ({ events: ref([]), isLoading: ref(false), error: ref(null), hasMore: ref(false), eventTypeFilter: ref(''), fromFilter: ref(''), toFilter: ref(''), loadEvents: async () => undefined, applyFilters: async () => undefined, loadMore: async () => undefined }),
      },
      alias: { '~/composables/useApi': { extractApiError: String } },
      components: { PageHeader: { template: '<div/>' }, FilterBar: { template: '<div><slot/></div>' }, Input: { template: '<input/>' }, LoadingState: { template: '<div/>' }, Button: { template: '<button/>' } },
    })
    const select = mounted.find('select').find((node) => node.props.id === 'timeline-event-type')
    expect(String(select?.props.class)).toContain('h-10')
    expect(String(select?.props.class)).toContain('border-input')
    mounted.unmount()
  })
})
