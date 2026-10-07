/** S3 §6 "Review changes": a line diff of a draft file against the version it was loaded at. */
export interface DiffLine { kind: 'same' | 'add' | 'del'; text: string }
export interface LineDiff { lines: DiffLine[]; approximate: boolean }

/** Above this many LCS cells the diff is a whole replacement (keeps a 256 KiB file from freezing the tab). */
const MAX_CELLS = 2_000_000

const toLines = (text: string): string[] => (text === '' ? [] : text.split('\n'))
const same = (text: string): DiffLine => ({ kind: 'same', text })
const del = (text: string): DiffLine => ({ kind: 'del', text })
const add = (text: string): DiffLine => ({ kind: 'add', text })

function lcsDiff(a: readonly string[], b: readonly string[]): DiffLine[] {
  const n = a.length
  const m = b.length
  const w = m + 1
  const dp = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1])
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) { out.push(same(a[i])); i += 1; j += 1 }
    else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { out.push(del(a[i])); i += 1 }
    else { out.push(add(b[j])); j += 1 }
  }
  return [...out, ...a.slice(i).map(del), ...b.slice(j).map(add)]
}

export function lineDiff(before: string, after: string): LineDiff {
  const a = toLines(before)
  const b = toLines(after)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA -= 1; endB -= 1 }
  const head = a.slice(0, start).map(same)
  const tail = a.slice(endA).map(same)
  const midA = a.slice(start, endA)
  const midB = b.slice(start, endB)
  if (midA.length * midB.length > MAX_CELLS) {
    return { lines: [...head, ...midA.map(del), ...midB.map(add), ...tail], approximate: true }
  }
  return { lines: [...head, ...lcsDiff(midA, midB), ...tail], approximate: false }
}
