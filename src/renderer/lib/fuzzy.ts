/** Tiny subsequence fuzzy matcher with word-boundary and recency scoring. */

export function fuzzyScore(query: string, text: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  if (t === q) return 10000
  if (t.startsWith(q)) return 5000 - t.length
  let score = 0
  let qi = 0
  let lastIdx = -1
  let streak = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      score += 10
      if (lastIdx === ti - 1) {
        streak += 1
        score += 8 * streak
      } else {
        streak = 0
      }
      if (ti === 0 || /[^a-z0-9]/i.test(t[ti - 1])) score += 12 // word boundary
      if (t[ti] === q[qi]) score += 1
      lastIdx = ti
      qi++
    }
  }
  if (qi < q.length) return null
  // Prefer compact matches near the start.
  score -= t.length * 0.1
  score -= lastIdx * 0.05
  return score
}

export function fuzzyFilter<T>(
  query: string,
  items: T[],
  getText: (item: T) => string,
): T[] {
  const q = query.trim()
  if (!q) return items
  return items
    .map((item) => ({ item, score: fuzzyScore(q, getText(item)) }))
    .filter((x): x is { item: T; score: number } => x.score !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.item)
}
