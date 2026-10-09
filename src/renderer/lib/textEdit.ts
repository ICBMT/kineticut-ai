/**
 * Exact-text edits for the agent. A model should change a file by naming the
 * text it wants replaced, not by re-writing the whole file: that is faster,
 * cannot silently drop code the model did not see, and the diff stays small.
 *
 * The rules are strict on purpose. The old text must exist, and it must be
 * unambiguous unless the caller asks for every occurrence. A failed edit says
 * why, so the model can read the file again and retry with exact text.
 */

export type EditResult =
  | { ok: true; content: string; replacements: number }
  | { ok: false; reason: string }

export function applyTextEdit(
  content: string,
  oldText: string,
  newText: string,
  replaceAll = false,
): EditResult {
  if (oldText === '') {
    return { ok: false, reason: 'old_text is empty. Give the exact text to replace.' }
  }
  if (oldText === newText) {
    return { ok: false, reason: 'old_text and new_text are identical; there is nothing to change.' }
  }

  // Files on Windows use CRLF. Match on LF and write the file back in its own style.
  const crlf = content.includes('\r\n')
  const normalized = crlf ? content.replace(/\r\n/g, '\n') : content
  const from = crlf ? oldText.replace(/\r\n/g, '\n') : oldText
  const to = crlf ? newText.replace(/\r\n/g, '\n') : newText

  const occurrences = countOccurrences(normalized, from)
  if (occurrences === 0) {
    return {
      ok: false,
      reason:
        'old_text was not found in the file. Read the file again and copy the exact text, including indentation and line breaks.',
    }
  }
  if (occurrences > 1 && !replaceAll) {
    return {
      ok: false,
      reason: `old_text matches ${occurrences} places. Include more surrounding lines so it matches once, or set replace_all to true.`,
    }
  }

  const next = replaceAll ? normalized.split(from).join(to) : normalized.replace(from, () => to)
  return {
    ok: true,
    content: crlf ? next.replace(/\n/g, '\r\n') : next,
    replacements: replaceAll ? occurrences : 1,
  }
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0
  let index = haystack.indexOf(needle)
  while (index !== -1) {
    count++
    index = haystack.indexOf(needle, index + needle.length)
  }
  return count
}
