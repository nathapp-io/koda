import { readFileSync } from 'node:fs'
import path from 'node:path'
import { proxyHeaders, resolveProxyTarget } from '~/server/utils/proxy-target'

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

describe('api proxy headers (#304)', () => {
  // h3 proxyRequest drops `accept`; content-negotiating routes (POST /api/mcp) need it.
  it("forwards the client's Accept", () => {
    expect(proxyHeaders('203.0.113.7', 'application/json, text/event-stream')).toEqual({
      accept: 'application/json, text/event-stream',
      'x-client-ip': '203.0.113.7',
    })
  })

  it('omits Accept when the client sent none', () => {
    expect(proxyHeaders('203.0.113.7', undefined)).toEqual({ 'x-client-ip': '203.0.113.7' })
  })

  it('keeps the fail-closed client IP placeholder', () => {
    expect(proxyHeaders(undefined, 'application/json')).toEqual({ accept: 'application/json', 'x-client-ip': '0.0.0.0' })
  })

  it('the catch-all proxy sends these headers', () => {
    const source = readFileSync(path.join(__dirname, '..', '..', 'server', 'api', '[...].ts'), 'utf8')
    expect(source).toMatch(/headers: proxyHeaders\(event\.context\.clientIp, getRequestHeader\(event, 'accept'\)\)/)
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
