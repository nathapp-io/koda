export interface RevealedText {
  text: string
  count: number
}

function isInvisible(codePoint: number): boolean {
  return (codePoint >= 0x0000 && codePoint <= 0x0008) ||
    (codePoint >= 0x000b && codePoint <= 0x001f) || codePoint === 0x007f || codePoint === 0x061c ||
    (codePoint >= 0x200b && codePoint <= 0x200f) || (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2064) || (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
}

/** Replaces each invisible or control character with a visible `<U+XXXX>` marker (uppercase hex, at least 4 digits). */
export function revealInvisible(input: string): RevealedText {
  let count = 0
  let text = ''
  for (const character of input) {
    const codePoint = character.codePointAt(0) ?? 0
    if (isInvisible(codePoint)) {
      count += 1
      text += `<U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}>`
    } else {
      text += character
    }
  }
  return { text, count }
}
