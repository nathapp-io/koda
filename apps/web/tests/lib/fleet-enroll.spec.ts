import { describe, expect, it } from '@jest/globals'
import { enrollCommand } from '~/lib/fleet-enroll'

describe('enrollCommand', () => {
  it('prints the documented enroll line', () => {
    expect(enrollCommand('https://koda.example.com', 'ke_abc')).toBe('koda-runner enroll --server https://koda.example.com --token ke_abc')
  })

  it('drops trailing slashes from the server', () => {
    expect(enrollCommand('https://koda.example.com//', 'ke_abc')).toBe('koda-runner enroll --server https://koda.example.com --token ke_abc')
  })
})
