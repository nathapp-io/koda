export default defineNuxtRouteMiddleware(async (to, _from) => {
  const auth = useAuth()

  // Guest-only routes where authenticated users should be redirected
  const guestOnlyRoutes = ['/login', '/register']

  // US-007: the public invite accept screen is visible signed in or out, so it
  // never bounces an anonymous visitor to /login (the API authorizes by token).
  if (to.path.startsWith('/invite/')) {
    return
  }

  // We only know the user is authenticated once /api/auth/me succeeds.
  // That endpoint uses the httpOnly cookie, so JS can probe it safely.
  if (!auth.user.value) {
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
