export default defineNuxtRouteMiddleware(async (to, _from) => {
  const auth = useAuth()

  // Guest-only routes where authenticated users should be redirected
  const guestOnlyRoutes = ['/login', '/register']

  // If we have a token cookie but no user loaded yet, validate it
  if (auth.token.value && !auth.user.value) {
    await auth.fetchUser()
  }

  // If unauthenticated and trying to access a protected route (not /login or /register)
  if (!auth.isAuthenticated.value && !guestOnlyRoutes.includes(to.path)) {
    return navigateTo('/login')
  }

  // If authenticated and trying to access a guest-only route
  if (auth.isAuthenticated.value && guestOnlyRoutes.includes(to.path)) {
    return navigateTo('/')
  }
})
