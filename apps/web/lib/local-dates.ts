import { onMounted, ref } from 'vue'
import { formatDate, formatDateTime } from '~/lib/format-date-time'

export interface LocalDates {
  dateTime(iso: string | null | undefined): string
  date(iso: string | null | undefined): string
}

export function useLocalDates(i18n: { locale?: { value?: unknown } } | undefined): LocalDates {
  const mounted = ref(false)
  onMounted(() => { mounted.value = true })
  const locale = typeof i18n?.locale?.value === 'string' && i18n.locale.value.length > 0
    ? i18n.locale.value
    : undefined
  const format = (iso: string | null | undefined, formatter: typeof formatDateTime | typeof formatDate): string => {
    if (iso === null || iso === undefined || iso === '') return '-'
    if (!mounted.value) return ''
    return formatter(iso, locale)
  }
  return {
    dateTime: iso => format(iso, formatDateTime),
    date: iso => format(iso, formatDate),
  }
}
