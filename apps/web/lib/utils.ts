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
