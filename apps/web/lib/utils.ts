import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function normalizeCapabilities(capabilities: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []

  for (const cap of capabilities) {
    const trimmed = cap.trim()
    if (!trimmed) continue

    const lower = trimmed.toLowerCase()
    if (seen.has(lower)) continue

    seen.add(lower)
    result.push(trimmed)
  }

  return result
}

const VALID_HEX_REGEX = /^#[0-9A-F]{6}$/

export function isValidColor(color: string): boolean {
  return VALID_HEX_REGEX.test(color)
}

export function getSafeColor(color: string, fallback: string = '#E5E7EB'): string {
  return isValidColor(color) ? color : fallback
}

export function normalizeHexColor(color: string): string {
  const hasPrefix = color.startsWith('#')
  let hex = color.replace(/[^0-9a-fA-F]/g, '')
  
  if (hex.length < 3) {
    hex = hex.padEnd(3, '0')
  }
  
  if (hex.length === 3) {
    if (hasPrefix) {
      hex = hex.split('').map(c => c + c).join('')
    } else {
      hex = (hex + '000').slice(0, 6)
    }
  }
  
  hex = hex.padEnd(6, '0').slice(0, 6)
  
  return `#${hex.toUpperCase()}`
}
