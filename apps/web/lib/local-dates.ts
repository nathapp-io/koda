import { onMounted, ref } from 'vue'
import { formatDate, formatDateTime } from '~/lib/format-date-time'

export interface LocalDates {
  dateTime(iso: string | null | undefined): string
  date(iso: string | null | undefined): string
}

export function useLocalDates(i18n: { locale?: { value?: unknown } } | undefined): LocalDates {
  const mounted = ref(false)
  onMounted(() => { mounted.value = true })
  /**
   * Read on every format call, never once in setup: LanguageSwitcher calls setLocale in place
   * (no_prefix routing, so no reload), and a snapshot taken in setup would keep every date in the
   * language the component first rendered with. Reading it inside the render (or a computed) is what
   * makes the read reactive, so a language switch re-formats without a remount.
   */
  const locale = (): string | undefined => {
    const value = i18n?.locale?.value
    return typeof value === 'string' && value.length > 0 ? value : undefined
  }
  const format = (iso: string | null | undefined, formatter: typeof formatDateTime | typeof formatDate): string => {
    if (iso === null || iso === undefined || iso === '') return '-'
    if (!mounted.value) return ''
    return formatter(iso, locale())
  }
  return {
    dateTime: iso => format(iso, formatDateTime),
    date: iso => format(iso, formatDate),
  }
}
