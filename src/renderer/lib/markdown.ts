import { marked } from 'marked'
import hljs from 'highlight.js/lib/common'
import DOMPurify from 'dompurify'

marked.use({ gfm: true, breaks: true })

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const renderer = new marked.Renderer()
renderer.code = ({ text, lang }: { text: string; lang?: string }) => {
  let highlighted: string
  if (text.length > 20000) {
    highlighted = escapeHtml(text)
  } else if (lang && hljs.getLanguage(lang)) {
    highlighted = hljs.highlight(text, { language: lang }).value
  } else {
    highlighted = hljs.highlightAuto(text).value
  }
  const langClass = lang ? ` language-${lang}` : ''
  return `<pre class="code-block"><code class="hljs${langClass}">${highlighted}</code></pre>`
}
marked.use({ renderer })

/** Render markdown to sanitized HTML for chat messages. */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source, { async: false }) as string
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } })
}

/** Strip a single wrapping ``` fence pair if the model fenced the whole output. */
export function stripCodeFences(text: string): string {
  const match = /^\s*```[a-zA-Z0-9]*\n([\s\S]*?)\n?```\s*$/.exec(text)
  return match ? match[1] : text
}
