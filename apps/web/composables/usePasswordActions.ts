import { extractErrorStatus } from '~/composables/useApi'

/**
 * The API `ret` behind `auth.currentPasswordWrong`
 * (`apps/api/src/i18n/{en,zh}/auth.json`): `AuthService.changePassword` throws a
 * ForbiddenAppException, so the auth catalog renders that message under 40003.
 * `useApi` unwraps the envelope into an `ApiError` carrying that ret (and, since the
 * US-003 fix, the HTTP status it came with), while an error that never reached the
 * envelope keeps only its status — hence both checks below.
 */
export const CURRENT_PASSWORD_WRONG_CODE = 40003

/** True when a failed password change means the submitted current password was wrong. */
export function isCurrentPasswordWrong(error: unknown): boolean {
  if (extractErrorStatus(error) === 403) return true
  return error !== null && typeof error === 'object' && (error as { code?: unknown }).code === CURRENT_PASSWORD_WRONG_CODE
}

export function usePasswordActions() {
  const { $api } = useApi()

  const changePassword = (input: { currentPassword: string; newPassword: string }) =>
    $api.post('/auth/password', { currentPassword: input.currentPassword, newPassword: input.newPassword })

  const requestReset = (email: string) => $api.post('/auth/password-reset', { email })
  const confirmReset = (token: string, newPassword: string) =>
    $api.post('/auth/password-reset/confirm', { token, newPassword })

  return { changePassword, requestReset, confirmReset }
}
