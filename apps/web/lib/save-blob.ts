/**
 * Hands a Blob to the browser as a file download (D127). The object URL is revoked after a delay:
 * Firefox and Safari can drop a download whose URL is revoked in the same tick as the click.
 */
export const REVOKE_DELAY_MS = 1000

export function saveBlob(blob: Blob, fileName: string): void {
  const link = document.createElement('a')
  const url = URL.createObjectURL(blob)
  try {
    link.href = url
    link.download = fileName
    document.body.appendChild(link)
    link.click()
  }
  finally {
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), REVOKE_DELAY_MS)
  }
}
