import { readFileSync } from 'node:fs'
import path from 'node:path'
import { resolveProxyTarget } from '~/server/utils/proxy-target'

describe('M23 api proxy target resolution', () => {
  it('proxies /api/tickets to the runtime-configured API target', () => {
    const target = resolveProxyTarget('/tickets', { apiInternalUrl: 'http://api:3100' })
    expect(target).toBe('http://api:3100/api/tickets')
  })

  it('appends /api to a bare internal URL', () => {
    const target = resolveProxyTarget('/projects', { apiInternalUrl: 'http://localhost:3100' })
    expect(target).toBe('http://localhost:3100/api/projects')
  })

  it('does not double-append /api when the internal URL already ends with /api', () => {
    const target = resolveProxyTarget('/tickets', { apiInternalUrl: 'http://api:3100/api' })
    expect(target).toBe('http://api:3100/api/tickets')
  })

  it('strips trailing slashes from the internal URL', () => {
    const target = resolveProxyTarget('/tickets', { apiInternalUrl: 'http://api:3100/' })
    expect(target).toBe('http://api:3100/api/tickets')
  })

  it('forwards query strings', () => {
    const target = resolveProxyTarget('/tickets?page=2&size=20', {
      apiInternalUrl: 'http://api:3100',
    })
    expect(target).toBe('http://api:3100/api/tickets?page=2&size=20')
  })

  it('handles the /api root (empty sub-path)', () => {
    const target = resolveProxyTarget('', { apiInternalUrl: 'http://api:3100' })
    expect(target).toBe('http://api:3100/api')
  })
})

describe('M23 routeRules shadowing removal', () => {
  it('nuxt.config.ts no longer registers a /api/** routeRule (the shadowing mechanism)', () => {
    const configPath = path.join(__dirname, '..', '..', 'nuxt.config.ts')
    const config = readFileSync(configPath, 'utf8')
    expect(config).not.toContain("'/api/**'")
    expect(config).not.toContain('"/api/**"')
  })
})
