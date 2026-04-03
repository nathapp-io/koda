/**
 * Normalize a color string to uppercase 6-digit hex format with leading #
 * - Expands 3-digit hex (#abc → #AABBCC)
 * - Ensures leading #
 * - Uppercases
 */
export function normalizeHexColor(value: string): string {
  let hex = value.startsWith('#') ? value : `#${value}`
  if (hex.length === 4) {
    // Expand 3-digit to 6-digit
    hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`
  }
  return hex.toUpperCase()
}

export function isValidHexColor(value: string): boolean {
  return /^#[0-9A-F]{6}$/.test(value)
}
