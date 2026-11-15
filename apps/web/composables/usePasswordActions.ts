export function usePasswordActions() {
  const { $api } = useApi()

  const changePassword = (input: { currentPassword: string; newPassword: string }) =>
    $api.post('/auth/password', { currentPassword: input.currentPassword, newPassword: input.newPassword })

  return { changePassword }
}
