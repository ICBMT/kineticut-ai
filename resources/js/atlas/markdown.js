/**
 * A deliberately small markdown renderer.
 *
 * The assistant's answers are prose with occasional code, and the atlas ships
 * no third-party runtime — a CDN import would break the offline promise of a
 * local model. This covers what the answers actually contain: paragraphs,
 * lists, headings, fenced code, inline code, bold and italic.
 *
 * Everything is escaped first, so nothing the model writes can become markup.
 */

const escape = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** Inline spans, applied to already-escaped text. */
function inline(text) {
    return text
        // [[key]] — the citation syntax the model is asked to use. The key is
        // left as a placeholder because only the panel knows the graph: it
        // swaps these for labelled, clickable chips once the HTML is in place.
        .replace(/\[\[([^\]\n]+)\]\]/g, '<span class="ai__cite ai__cite--inline" data-cite="$1"></span>')
        // `code`
        .replace(/`([^`\n]+)`/g, '<code>$1</code>')
        // **bold**
        .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
        // *italic* — after bold so ** is not eaten
        .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>');
}

/**
 * Render markdown to HTML. Tolerates an unfinished answer — a streaming reply
 * is rendered after every chunk, so an unclosed code fence must not swallow
 * the rest of the page.
 */
export function renderMarkdown(source) {
    const lines = escape(source).split('\n');
    const out = [];

    let inCode = false;
    let code = [];
    let list = null; // 'ul' | 'ol'
    let paragraph = [];

    const closeParagraph = () => {
        if (paragraph.length) {
            out.push(`<p>${inline(paragraph.join(' '))}</p>`);
            paragraph = [];
        }
    };

    const closeList = () => {
        if (list) {
            out.push(`</${list}>`);
            list = null;
        }
    };

    const openList = (kind) => {
        if (list !== kind) {
            closeList();
            out.push(`<${kind}>`);
            list = kind;
        }
    };

    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');

        const fence = line.match(/^\s*```(\w*)\s*$/);

        if (fence) {
            closeParagraph();
            closeList();

            if (inCode) {
                out.push(`<pre class="ai-code">${code.join('\n')}</pre>`);
                code = [];
                inCode = false;
            } else {
                inCode = true;
            }

            continue;
        }

        if (inCode) {
            code.push(line);
            continue;
        }

        if (line.trim() === '') {
            closeParagraph();
            closeList();
            continue;
        }

        // `>` arrives as `&gt;` because the text was escaped before it got here.
        const quote = line.match(/^\s{0,3}(?:>|&gt;)\s?(.*)$/);

        if (quote) {
            closeParagraph();
            closeList();
            out.push(`<blockquote>${inline(quote[1])}</blockquote>`);
            continue;
        }

        const heading = line.match(/^\s{0,3}(#{1,4})\s+(.*)$/);

        if (heading) {
            closeParagraph();
            closeList();
            const level = Math.min(6, heading[1].length + 2);
            out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
            continue;
        }

        const bullet = line.match(/^\s*([-*•])\s+(.*)$/);

        if (bullet) {
            closeParagraph();
            openList('ul');
            out.push(`<li>${inline(bullet[2])}</li>`);
            continue;
        }

        const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);

        if (numbered) {
            closeParagraph();
            openList('ol');
            out.push(`<li>${inline(numbered[2])}</li>`);
            continue;
        }

        closeList();
        paragraph.push(line.trim());
    }

    // An answer that ended mid-fence still shows what it managed to write.
    if (inCode && code.length) {
        out.push(`<pre class="ai-code">${code.join('\n')}</pre>`);
    }

    closeParagraph();
    closeList();

    return out.join('');
}

export { escape as escapeHtml };
