/**
 * JS port of src/shared/purpose.ts (the dev server is plain .mjs).
 * Kept in sync — "what is this app for?" derived from index-cached metadata.
 */

/** First meaningful prose of a README excerpt (headings/badges/links stripped). */
function readmeLead(text) {
  const parts = []
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim()
    if (!line) {
      if (parts.length > 0) break
      continue
    }
    if (line.startsWith('#')) continue // headings
    if (/^[!<]/.test(line)) continue // html / badge blocks
    line = line.replace(/!\[[^\]]*\]\([^)]*\)/g, '') // images
    line = line.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // links → link text
    line = line.replace(/[*_`>]+/g, '').trim()
    if (!line) continue
    parts.push(line)
    if (parts.join(' ').length > 280) break
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/**
 * One-line purpose of the project: the package.json description, else the
 * first prose paragraph of the README. Undefined when nothing usable exists.
 */
export function derivePurpose(packageJson, readmeExcerpt) {
  const desc =
    packageJson && typeof packageJson.description === 'string'
      ? packageJson.description.trim()
      : ''
  if (desc) return desc.slice(0, 300)
  if (readmeExcerpt) {
    const lead = readmeLead(readmeExcerpt)
    if (lead) return lead.slice(0, 300)
  }
  return undefined
}
