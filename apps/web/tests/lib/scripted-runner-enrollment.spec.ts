import { ScriptedRunner } from '../e2e/fixtures/scripted-runner'

describe('scripted runner enrollment throttling', () => {
  const answer = (status: number, data: unknown, retryAfter?: string) => new Response(
    JSON.stringify({ ret: status === 201 ? 0 : status, data }),
    { status, headers: retryAfter ? { 'Retry-After': retryAfter } : {} },
  )

  beforeEach(() => { jest.useFakeTimers() })
  afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers() })

  test('waits for Retry-After and reuses the single-use token after a 429', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(answer(201, { token: 'enrollment-token' }))
      .mockResolvedValueOnce(answer(429, null, '2'))
      .mockResolvedValueOnce(answer(201, { runnerId: 'runner', apiKey: 'key' }))
    const pending = ScriptedRunner.enroll('admin', 'runner-name')
    const result = expect(pending).resolves.toMatchObject({ id: 'runner' })
    await jest.advanceTimersByTimeAsync(1999)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(1)
    await result
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(fetchMock.mock.calls[1]?.[1]?.body)
  })

  test('fails immediately for an invalid enrollment token', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(answer(201, { token: 'expired' }))
      .mockResolvedValueOnce(answer(401, null))
    await expect(ScriptedRunner.enroll('admin', 'runner-name')).rejects.toThrow('failed: 401')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  test('stops retrying when the rate limit outlasts the retry budget', async () => {
    jest.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(answer(201, { token: 'token' }))
      .mockImplementation(async () => answer(429, null, '60'))
    const pending = ScriptedRunner.enroll('admin', 'runner-name')
    const result = expect(pending).rejects.toThrow('failed: 429')
    await jest.advanceTimersByTimeAsync(65_000)
    await result
  })
})
