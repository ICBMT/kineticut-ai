/**
 * Line diff in hunks, for reviewing agent changes one hunk at a time. A hunk is
 * a run of changed lines: `oldLines` (from the original) are replaced by
 * `newLines` (from the proposed file). Accepting or rejecting each hunk and then
 * rebuilding the file gives exactly the file the user chose.
 */

export interface Hunk {
  /** Index of the first original line in this hunk. */
  oldStart: number
  /** Original lines this hunk replaces (may be empty for a pure insertion). */
  oldLines: string[]
  /** Lines it puts in their place (may be empty for a pure deletion). */
  newLines: string[]
}

/** Above this many cells the LCS table is too large; the middle is one hunk instead. */
const MAX_LCS_CELLS = 4_000_000

export function splitLines(text: string): string[] {
  return text === '' ? [] : text.split('\n')
}

/** Split `original` into the hunks needed to become `proposed`. */
export function computeHunks(original: string, proposed: string): Hunk[] {
  const a = splitLines(original)
  const b = splitLines(proposed)

  // Trim the common head and tail: most edits touch a small middle.
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tailA = a.length
  let tailB = b.length
  while (tailA > head && tailB > head && a[tailA - 1] === b[tailB - 1]) {
    tailA--
    tailB--
  }
  const midA = a.slice(head, tailA)
  const midB = b.slice(head, tailB)
  if (midA.length === 0 && midB.length === 0) return []

  // Matched pairs (i in midA, j in midB) from a longest-common-subsequence table.
  let pairs: Array<[number, number]>
  if (midA.length * midB.length > MAX_LCS_CELLS) {
    pairs = []
  } else {
    pairs = lcsPairs(midA, midB)
  }

  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  const flush = (ni: number, nj: number) => {
    if (ni > i || nj > j) {
      hunks.push({
        oldStart: head + i,
        oldLines: midA.slice(i, ni),
        newLines: midB.slice(j, nj),
      })
    }
    i = ni
    j = nj
  }
  for (const [pi, pj] of pairs) {
    flush(pi, pj)
    i = pi + 1
    j = pj + 1
  }
  flush(midA.length, midB.length)
  return hunks
}

function lcsPairs(a: string[], b: string[]): Array<[number, number]> {
  const n = a.length
  const m = b.length
  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: Uint32Array[] = []
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const pairs: Array<[number, number]> = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j])
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++
    } else {
      j++
    }
  }
  return pairs
}

/**
 * Build the file from the original and the hunks, taking the proposed lines for
 * accepted hunks and the original lines for rejected ones.
 */
export function applyHunkDecisions(original: string, hunks: Hunk[], accepted: boolean[]): string {
  const a = splitLines(original)
  const out: string[] = []
  let pos = 0
  hunks.forEach((h, k) => {
    out.push(...a.slice(pos, h.oldStart))
    out.push(...(accepted[k] ? h.newLines : h.oldLines))
    pos = h.oldStart + h.oldLines.length
  })
  out.push(...a.slice(pos))
  return out.join('\n')
}

/** Count of added and removed lines, for the review summary. */
export function countChanges(hunks: Hunk[]): { added: number; removed: number } {
  return hunks.reduce(
    (acc, h) => ({ added: acc.added + h.newLines.length, removed: acc.removed + h.oldLines.length }),
    { added: 0, removed: 0 },
  )
}
