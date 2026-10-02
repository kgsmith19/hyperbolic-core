/**
 * Minimal, safe Markdown renderer for research reports.
 * Escapes all input first, then applies a small, predictable subset:
 * headings, paragraphs, lists (nested by indent), blockquotes, bold/italic,
 * inline code, links, horizontal rules, and [n] citation chips.
 */
(function () {
    function esc(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function slug(text) {
        return String(text).toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
    }

    function inline(text, opts) {
        let out = esc(text);
        out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
        out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
        out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
        out = out.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
        out = out.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
        if (opts && opts.citations) {
            out = out.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (match, nums) => nums.split(',').map(n => {
                const k = n.trim();
                return `<button type="button" class="cite" data-cite="${k}" aria-label="Source ${k}">${k}</button>`;
            }).join(''));
        }
        return out;
    }

    function render(markdown, opts = {}) {
        const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
        const html = [];
        let para = [];
        const listStack = []; // {type, indent}
        let inQuote = false;

        const flushPara = () => {
            if (para.length) {
                html.push(`<p>${inline(para.join(' '), opts)}</p>`);
                para = [];
            }
        };
        const closeLists = (toIndent = -1) => {
            while (listStack.length && listStack[listStack.length - 1].indent > toIndent) {
                html.push(`</li></${listStack.pop().type}>`);
            }
        };
        const closeQuote = () => {
            if (inQuote) { flushPara(); html.push('</blockquote>'); inQuote = false; }
        };

        for (const raw of lines) {
            const line = raw.replace(/\s+$/, '');
            if (!line.trim()) { flushPara(); closeLists(); closeQuote(); continue; }

            const heading = line.match(/^(#{1,4})\s+(.*)$/);
            if (heading) {
                flushPara(); closeLists(); closeQuote();
                const level = Math.min(4, heading[1].length + (opts.shiftHeadings || 0));
                const content = inline(heading[2], opts);
                html.push(`<h${level} id="h-${slug(heading[2])}">${content}</h${level}>`);
                continue;
            }
            if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
                flushPara(); closeLists(); closeQuote(); html.push('<hr>'); continue;
            }
            const quote = line.match(/^>\s?(.*)$/);
            if (quote) {
                closeLists();
                if (!inQuote) { flushPara(); html.push('<blockquote>'); inQuote = true; }
                para.push(quote[1]);
                continue;
            }
            const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
            if (item) {
                flushPara(); closeQuote();
                const indent = item[1].replace(/\t/g, '    ').length;
                const type = /\d/.test(item[2]) ? 'ol' : 'ul';
                const top = listStack[listStack.length - 1];
                if (!top || indent > top.indent) {
                    html.push(`<${type}><li>`);
                    listStack.push({ type, indent });
                } else {
                    closeLists(indent);
                    const cur = listStack[listStack.length - 1];
                    if (cur && cur.indent === indent) {
                        html.push('</li><li>');
                    } else {
                        html.push(`<${type}><li>`);
                        listStack.push({ type, indent });
                    }
                }
                html.push(inline(item[3], opts));
                continue;
            }
            if (listStack.length && /^\s{2,}\S/.test(raw)) {
                html.push(' ' + inline(line.trim(), opts));
                continue;
            }
            closeLists();
            para.push(line.trim());
        }
        flushPara(); closeLists(); closeQuote();
        return html.join('\n');
    }

    window.Markdown = { render, escape: esc, slug };
})();
