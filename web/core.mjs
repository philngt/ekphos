/** Pure Markdown / knowledge-index helpers. No DOM, network, or filesystem access. */
export const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const isMarkdown = (path) => /\.(md|markdown)$/i.test(path);
export const stem = (path) => path.split('/').at(-1).replace(/\.(md|markdown)$/i, '');
export const fold = (text) => text.normalize('NFKC').toLowerCase();
const nameKey = (text) => fold(text).replace(/[\s_-]+/g, ' ').trim();
export const slug = (text) => fold(text).replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/[\s_]+/g, '-');

export function safeExternalUrl(value) {
  if (/^[\s\S]*[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

/** Resolve a vault-relative path, never allowing traversal above the selected root. */
export function resolvePath(target, from = '') {
  try { target = decodeURIComponent(target); } catch { return null; }
  if (!target || /[\u0000-\u001f\\]/.test(target) || /^[a-z][a-z\d+.-]*:/i.test(target) || target.startsWith('//')) return null;
  const parts = target.startsWith('/') ? [] : from.split('/').slice(0, -1);
  for (const part of target.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else { if (part.startsWith('.')) return null; parts.push(part); }
  }
  return parts.join('/');
}

export function validateNotePath(input) {
  let path = input.trim();
  if (!path || path.length > 220 || path.startsWith('/') || path.endsWith('/')) throw new Error('Enter a relative note path, such as Research/New idea.md.');
  if (!isMarkdown(path)) path += '.md';
  for (const part of path.split('/')) {
    if (!part || part.startsWith('.') || /[\\<>:"|?*\u0000-\u001f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) {
      throw new Error('Use ordinary folder and file names; hidden paths, traversal, and reserved characters are not allowed.');
    }
  }
  return path;
}

function unquote(value) {
  value = value.trim();
  if (value.startsWith('"') && value.endsWith('"')) { try { return JSON.parse(value); } catch { /* Preserve unrecognized YAML as text. */ } }
  return value.replace(/^(['"])(.*)\1$/, '$2');
}

function frontmatter(lines) {
  if (lines[0]?.replace(/^\uFEFF/, '').trim() !== '---') return { start: 0, raw: '', properties: {} };
  const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end < 0) return { start: 0, raw: '', properties: {} };
  const properties = {};
  let listKey = '';
  for (const line of lines.slice(1, end)) {
    const field = /^(title|tags|aliases):\s*(.*?)\s*$/.exec(line);
    if (field) {
      const [, key, value] = field;
      listKey = key;
      properties[key] = key === 'title' ? unquote(value) : value.replace(/^\[|\]$/g, '').split(',').map(unquote).filter(Boolean);
    } else if (['tags', 'aliases'].includes(listKey) && /^\s+-\s+/.test(line)) {
      properties[listKey].push(unquote(line.replace(/^\s+-\s+/, '')));
    } else if (/^\S/.test(line)) listKey = '';
  }
  return { start: end + 1, raw: lines.slice(1, end).join('\n'), properties };
}

/** A deliberately small, safe inline grammar; raw HTML is always text. */
export function inlineTokens(text) {
  const pattern = /\\([\\`*_[\]{}()#+.!|>~-])|(`+)([\s\S]*?)\2|(!?)\[\[([^\]\n]+)\]\]|(!?)\[([^\]\n]*)\]\(([^)\n]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_/g;
  const result = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) result.push({ type: 'text', text: text.slice(last, match.index) });
    if (match[1]) result.push({ type: 'text', text: match[1] });
    else if (match[2]) result.push({ type: 'code', text: match[3] });
    else if (match[5]) {
      const [target, ...alias] = match[5].split('|');
      result.push({ type: match[4] ? 'image' : 'link', target: target.trim(), text: alias.join('|') || target, wiki: true });
    } else if (match[8]) result.push({ type: match[6] ? 'image' : 'link', target: match[8].trim().replace(/^<|>$/g, ''), text: match[7], wiki: false });
    else result.push({ type: match[9] || match[10] ? 'strong' : match[11] ? 'del' : 'em', text: match[9] || match[10] || match[11] || match[12] || match[13] });
    last = match.index + match[0].length;
  }
  if (last < text.length) result.push({ type: 'text', text: text.slice(last) });
  return result;
}

function walkInline(text, visitor, depth = 0) {
  for (const token of inlineTokens(text)) {
    visitor(token);
    if (depth < 8 && ['strong', 'em', 'del'].includes(token.type)) walkInline(token.text, visitor, depth + 1);
  }
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((s) => s.trim().replace(/\\\|/g, '|'));
}
const isTableRule = (line) => !!line && line.includes('|') && cells(line).every((s) => /^:?-{3,}:?$/.test(s));
const listItem = (line) => /^\s{0,3}([-+*]|\d+[.)])\s+(?:\[([ xX])\]\s+)?(.*)$/.exec(line);
const isBlockStart = (lines, i) => /^\s{0,3}(#{1,6}\s|`{3,}|~{3,}|>|(?:[-*_]\s*){3,}$)/.test(lines[i] || '') || !!listItem(lines[i] || '') || isTableRule(lines[i + 1]);

export function parseNote(path, content) {
  const lines = content.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/);
  const meta = frontmatter(lines);
  const blocks = [], headings = [], links = [], tasks = [], tags = new Set(meta.properties.tags || []), ids = new Map();
  const collect = (text) => walkInline(text, (token) => {
    if (token.type === 'link' && !safeExternalUrl(token.target) && !/^[a-z][a-z\d+.-]*:/i.test(token.target)) links.push({ target: token.target, label: token.text, wiki: token.wiki });
    if (token.type === 'text') for (const m of token.text.matchAll(/(?:^|\s)#([\p{L}\p{N}_/-]+)/gu)) tags.add(m[1]);
  });
  for (let i = meta.start; i < lines.length;) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      const start = i++, body = [], close = new RegExp(`^\\s{0,3}${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ type: 'code', text: body.join('\n'), language: fence[2].trim(), line: start }); continue;
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
    if (heading) {
      const base = slug(heading[2]) || 'section', count = ids.get(base) || 0;
      ids.set(base, count + 1);
      const block = { type: 'heading', level: heading[1].length, text: heading[2], id: count ? `${base}-${count}` : base, line: i++ };
      headings.push(block); blocks.push(block); collect(block.text); continue;
    }
    if (/^\s{0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/.test(line)) { blocks.push({ type: 'rule', line: i++ }); continue; }
    if (isTableRule(lines[i + 1])) {
      const block = { type: 'table', header: cells(line), rows: [], line: i };
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) block.rows.push(cells(lines[i++]));
      [...block.header, ...block.rows.flat()].forEach(collect); blocks.push(block); continue;
    }
    if (listItem(line)) {
      const ordered = /^\d/.test(listItem(line)[1]);
      const block = { type: 'list', ordered, items: [], line: i };
      while (i < lines.length) {
        const item = listItem(lines[i]);
        if (!item || /^\d/.test(item[1]) !== ordered) break;
        const row = { text: item[3], checked: item[2] === undefined ? null : item[2].toLowerCase() === 'x', line: i++ };
        block.items.push(row); if (row.checked !== null) tasks.push(row); collect(row.text);
      }
      blocks.push(block); continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      const start = i, body = [];
      while (i < lines.length && /^\s{0,3}>/.test(lines[i])) body.push(lines[i++].replace(/^\s{0,3}>\s?/, ''));
      blocks.push({ type: 'quote', text: body.join('\n'), line: start }); collect(body.join('\n')); continue;
    }
    const start = i, paragraph = [lines[i++]];
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines, i)) paragraph.push(lines[i++]);
    blocks.push({ type: 'paragraph', text: paragraph.join('\n'), line: start }); collect(paragraph.join('\n'));
  }
  const body = lines.slice(meta.start).join('\n');
  return { path, content, title: meta.properties.title || headings.find((h) => h.level === 1)?.text || stem(path), blocks, headings, links, tasks, tags: [...tags].map((t) => t.replace(/^#/, '')).filter(Boolean), aliases: meta.properties.aliases || [], frontmatter: meta.raw, words: body.trim() ? body.trim().split(/\s+/u).length : 0, eol: content.includes('\r\n') ? '\r\n' : '\n' };
}

export function renderInline(text, depth = 0) {
  if (depth > 8) return escapeHtml(text);
  return inlineTokens(text).map((token) => {
    const label = escapeHtml(token.text);
    if (token.type === 'text') return label;
    if (token.type === 'code') return `<code>${label}</code>`;
    if (['strong', 'em', 'del'].includes(token.type)) return `<${token.type}>${renderInline(token.text, depth + 1)}</${token.type}>`;
    if (token.type === 'image') return `<span class="asset-placeholder" data-asset="${escapeHtml(token.target)}" data-alt="${label}">Image: ${label || escapeHtml(token.target)} <small>(local raster images only)</small></span>`;
    const external = safeExternalUrl(token.target);
    if (external) return `<a href="${escapeHtml(external)}" target="_blank" rel="noopener noreferrer">${label}<span class="external-mark" aria-hidden="true"> ↗</span></a>`;
    if (/^[a-z][a-z\d+.-]*:/i.test(token.target) || token.target.startsWith('//') || /[\u0000-\u001f]/.test(token.target)) return label;
    return `<button class="wikilink" type="button" data-link="${escapeHtml(token.target)}">${label}</button>`;
  }).join('');
}

export function renderMarkdown(note) {
  return note.blocks.map((block) => {
    const text = block.text || '';
    switch (block.type) {
      case 'heading': return `<h${block.level} id="heading-${escapeHtml(block.id)}">${renderInline(text)}</h${block.level}>`;
      case 'code': return `<div class="code-block"><div class="code-language">${escapeHtml(block.language || 'plain text')}</div><pre><code>${escapeHtml(text)}</code></pre></div>`;
      case 'rule': return '<hr>';
      case 'quote': return `<blockquote>${renderInline(text)}</blockquote>`;
      case 'table': return `<div class="table-scroll"><table><thead><tr>${block.header.map((c) => `<th>${renderInline(c)}</th>`).join('')}</tr></thead><tbody>${block.rows.map((row) => `<tr>${block.header.map((_, i) => `<td>${renderInline(row[i] || '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
      case 'list': { const tag = block.ordered ? 'ol' : 'ul'; return `<${tag}>${block.items.map((item) => `<li${item.checked !== null ? ' class="task-item"' : ''}>${item.checked !== null ? `<input type="checkbox" data-task="${item.line}" aria-label="${escapeHtml(item.text)}"${item.checked ? ' checked' : ''}> ` : ''}${renderInline(item.text)}</li>`).join('')}</${tag}>`; }
      default: return `<p>${renderInline(text)}</p>`;
    }
  }).join('');
}

export function toggleTask(content, lineNumber, checked) {
  const chunks = content.split(/(\r\n|\n|\r)/);
  const index = Number(lineNumber) * 2;
  if (!Number.isInteger(index) || !chunks[index] || !/^\s{0,3}(?:[-+*]|\d+[.)])\s+\[[ xX]\]/.test(chunks[index])) return content;
  chunks[index] = chunks[index].replace(/^(\s{0,3}(?:[-+*]|\d+[.)])\s+\[)[ xX](\])/, `$1${checked ? 'x' : ' '}$2`);
  return chunks.join('');
}

export function createResolver(notes) {
  const paths = new Map(), names = new Map();
  const add = (map, key, note) => { const values = map.get(key) || []; if (!values.includes(note)) values.push(note); map.set(key, values); };
  for (const note of notes.values()) {
    add(paths, fold(note.path), note);
    for (const name of [stem(note.path), note.title, ...note.aliases]) add(names, nameKey(name), note);
  }
  return (raw, from) => {
    const [target, ...anchor] = raw.split('#');
    const heading = anchor.join('#');
    if (!target) return { note: notes.get(from), heading, matches: [] };
    const possible = [resolvePath(target, from), resolvePath(target, '')].filter(Boolean);
    for (const path of possible) {
      const variants = isMarkdown(path) ? [path] : [path + '.md', path + '.markdown'];
      for (const variant of variants) {
        const matches = paths.get(fold(variant)) || [];
        if (matches.length) return { note: matches.length === 1 ? matches[0] : null, matches, heading };
      }
    }
    let decoded;
    try { decoded = decodeURIComponent(target); } catch { return { note: null, matches: [], heading }; }
    const matches = decoded.includes('/') || !resolvePath(target, '') ? [] : names.get(nameKey(decoded.replace(/\.(md|markdown)$/i, ''))) || [];
    return { note: matches.length === 1 ? matches[0] : null, matches, heading };
  };
}

export function buildKnowledgeIndex(notes) {
  const resolve = createResolver(notes), edges = [], backlinks = new Map(), outgoing = new Map(), unresolved = new Map(), seen = new Set();
  for (const source of notes.values()) {
    for (const link of source.links) {
      const result = resolve(link.target, source.path);
      if (!result.note) { const missing = unresolved.get(source.path) || []; missing.push({ ...link, ambiguous: result.matches.length > 1 }); unresolved.set(source.path, missing); continue; }
      if (result.note.path === source.path) continue;
      const key = JSON.stringify([source.path, result.note.path]);
      if (seen.has(key)) continue;
      seen.add(key); edges.push({ source: source.path, target: result.note.path });
      const incoming = backlinks.get(result.note.path) || []; incoming.push(source.path); backlinks.set(result.note.path, incoming);
      const out = outgoing.get(source.path) || []; out.push(result.note.path); outgoing.set(source.path, out);
    }
  }
  return { resolve, edges, backlinks, outgoing, unresolved };
}

export function searchNotes(notes, query = '', tag = '', recent = false) {
  const terms = fold(query.trim()).split(/\s+/).filter(Boolean);
  return [...notes.values()].map((note) => {
    const haystack = fold(`${note.title}\n${note.path}\n${note.content}`);
    const matches = (!tag || note.tags.some((t) => fold(t) === fold(tag))) && terms.every((t) => t.startsWith('#') ? note.tags.some((v) => fold(v) === t.slice(1)) : haystack.includes(t));
    const score = terms.reduce((sum, t) => sum + (fold(note.title).includes(t) ? 4 : fold(note.path).includes(t) ? 2 : 1), 0);
    return { note, matches, score };
  }).filter((r) => r.matches).sort((a, b) => (recent ? (b.note.modified || 0) - (a.note.modified || 0) : b.score - a.score) || a.note.path.localeCompare(b.note.path)).map((r) => r.note);
}

export const DEMO_NOTES = {
  'Start here.md': '# A place for connected thinking\n\nWelcome to your research workspace. Follow an idea, connect the dots, and keep your notes close.\n\n> This is an example vault, kept only in this tab. Open your own folder to work with real Markdown files.\n\n## Follow the thread\n\nStart with [[Research/Local-first software|local-first software]], explore [[Research/Connected notes|connected notes]], or capture a thought in [[Inbox/Small ideas|your inbox]].\n\n## Make room for discovery\n\n- [x] Find a quieter place to think\n- [ ] Connect two ideas with a wikilink\n- [ ] Open a folder of your own\n\n## Your notes, your files\n\nUse **Read**, **Split**, or **Edit** to find your rhythm. The web UI and terminal use the same `.md` files. Save is always explicit.\n\n| Action | Shortcut |\n| --- | --- |\n| Find a note or command | Ctrl / ⌘ K |\n| Save a note | Ctrl / ⌘ S |\n| New note | Ctrl / ⌘ Shift N |\n\n#research #getting-started\n',
  'Research/Local-first software.md': '---\ntitle: Local-first software\ntags: [research, software]\n---\n\n# Local-first software\n\nGood tools should leave you in control of your work. A folder of plain-text notes is a useful starting point.\n\n## Principles\n\n- Work without a network connection.\n- Keep files readable outside the application.\n- Make changes deliberate and visible.\n\n## Open questions\n\nHow can [[Connected notes]] help us discover patterns without adding noise?\n\nSee [[../Start here|the workspace guide]] and [[../Inbox/Small ideas]].\n',
  'Research/Connected notes.md': '---\ntags:\n  - research\n  - thinking\n---\n\n# Connected notes\n\nA note becomes more useful when it has context. A link can express a question, a contrast, or a supporting idea.\n\n## A small practice\n\n1. Capture one idea.\n2. Write why it matters.\n3. Link it to something you already know.\n\n[[Local-first software]] keeps those connections in your own files. [[../Start here]] is the starting point.\n',
  'Inbox/Small ideas.md': '# Small ideas\n\nNot every thought needs a system. Start with a sentence.\n\n- [ ] Sketch a reading workflow\n- [ ] Revisit [[Research questions]]\n- [ ] Add context to [[../Research/Connected notes]]\n\n#inbox #thinking\n',
  'Inbox/Research questions.md': '# Research questions\n\n## What makes a note useful?\n\nA clear idea, a source, and a reason to revisit it.\n\n## Next reading\n\nCompare the approach in [[../Research/Connected notes]] with [[../Research/Local-first software]].\n\n#research\n',
};
