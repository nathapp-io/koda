export function usePasswordActions() {
  const { $api } = useApi()

  const changePassword = (input: { currentPassword: string; newPassword: string }) =>
    $api.post('/auth/password', { currentPassword: input.currentPassword, newPassword: input.newPassword })

  const requestReset = (email: string) => $api.post('/auth/password-reset', { email })
  const confirmReset = (token: string, newPassword: string) =>
    $api.post('/auth/password-reset/confirm', { token, newPassword })

  return { changePassword, requestReset, confirmReset }
}
