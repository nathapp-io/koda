import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals'
import { REVOKE_DELAY_MS, saveBlob } from '~/lib/save-blob'

const g = globalThis as Record<string, unknown>

describe('saveBlob', () => {
  let link: { href: string; download: string; click: jest.Mock; remove: jest.Mock }
  let createObjectURL: jest.SpiedFunction<typeof URL.createObjectURL>
  let revokeObjectURL: jest.SpiedFunction<typeof URL.revokeObjectURL>

  beforeEach(() => {
    link = { href: '', download: '', click: jest.fn(), remove: jest.fn() }
    g.document = { createElement: jest.fn(() => link), body: { appendChild: jest.fn() } }
    createObjectURL = jest.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x')
    revokeObjectURL = jest.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined)
    jest.useFakeTimers()
  })

  afterEach(() => {
    jest.useRealTimers()
    delete g.document
    createObjectURL.mockRestore()
    revokeObjectURL.mockRestore()
  })

  test('clicks a link to the object URL with the file name, then removes the link', () => {
    const blob = new Blob(['gz'])
    saveBlob(blob, 'koda-job-j1.tar.gz')
    expect(createObjectURL).toHaveBeenCalledWith(blob)
    expect(link).toMatchObject({ href: 'blob:x', download: 'koda-job-j1.tar.gz' })
    expect(link.click).toHaveBeenCalledTimes(1)
    expect(link.remove).toHaveBeenCalledTimes(1)
  })

  test('revokes the object URL only after the delay (Firefox and Safari drop a download revoked in the click tick)', () => {
    saveBlob(new Blob(['gz']), 'f.tar.gz')
    expect(revokeObjectURL).not.toHaveBeenCalled()
    jest.advanceTimersByTime(REVOKE_DELAY_MS)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x')
  })

  test('still removes the link and revokes when the click throws', () => {
    link.click.mockImplementation(() => { throw new Error('blocked') })
    expect(() => saveBlob(new Blob(['gz']), 'f.tar.gz')).toThrow('blocked')
    expect(link.remove).toHaveBeenCalledTimes(1)
    jest.advanceTimersByTime(REVOKE_DELAY_MS)
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:x')
  })
})
