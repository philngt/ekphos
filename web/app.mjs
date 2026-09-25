import { parseNote, renderMarkdown, stem, fold, slug, validateNotePath, resolvePath, buildKnowledgeIndex, searchNotes, toggleTask } from './core.mjs';
import { DirectoryVault, ImportedVault, DemoVault, isDirty, reconcileRefresh, loadNote } from './vault.mjs';

const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const pref = (key, fallback) => { try { return localStorage.getItem(`ekphos.ui.${key}`) || fallback; } catch { return fallback; } };
const remember = (key, value) => { try { localStorage.setItem(`ekphos.ui.${key}`, value); } catch { /* Preferences are optional. */ } };
const state = { vault: null, notes: new Map(), selected: null, index: buildKnowledgeIndex(new Map()), query: '', tag: '', recent: false, graph: false, view: pref('view', 'read'), busy: false, saving: null, warnings: [], collapsed: new Set(), graphBox: [0, 0, 900, 620] };
if (!['read', 'split', 'edit'].includes(state.view)) state.view = 'read';
let editTimer, toastTimer, previewGeneration = 0, confirmResolve = null, commandItems = [], commandIndex = 0, commandCandidates = null;
const pendingMetadata = new Set(), objectUrls = new Set();
const current = () => state.notes.get(state.selected);
const drafts = () => [...state.notes.values()].filter(isDirty);
const filtered = () => searchNotes(state.notes, state.query, state.tag, state.recent);
const el = (tag, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
function icon(name) { const svg = document.createElementNS(SVG, 'svg'), use = document.createElementNS(SVG, 'use'); use.setAttribute('href', `#i-${name}`); svg.setAttribute('aria-hidden', 'true'); svg.append(use); return svg; }
function svgEl(tag, attrs = {}) { const node = document.createElementNS(SVG, tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); return node; }
function toast(message, error = false) { clearTimeout(toastTimer); $('toast').textContent = message; $('toast').classList.toggle('error', error); $('toast').hidden = false; toastTimer = setTimeout(() => { $('toast').hidden = true; }, error ? 9000 : 4200); }
function showInfo(title, text) { $('info-title').textContent = title; $('info-content').textContent = text; if (!$('info-dialog').open) $('info-dialog').showModal(); }
function confirmAction(title, message, action = 'Discard drafts') {
  if (confirmResolve) return Promise.resolve(false);
  $('confirm-title').textContent = title; $('confirm-message').textContent = message; $('confirm-yes').textContent = action;
  $('confirm-dialog').showModal(); $('confirm-no').focus();
  return new Promise((resolve) => { confirmResolve = resolve; });
}
function settleConfirm(value) { $('confirm-dialog').close(); const resolve = confirmResolve; confirmResolve = null; resolve?.(value); }
const canLeave = () => !drafts().length ? Promise.resolve(true) : confirmAction('Leave these drafts behind?', `${drafts().length} unsaved draft(s) exist only in this tab. Save or download them before switching vaults. Canceling the folder picker will keep this workspace.`);
function blocked() { if (state.busy || state.saving) { toast('Finish the current file operation before starting another.'); return true; } return false; }
async function busy(work) {
  if (blocked()) return;
  state.busy = true; renderStatus();
  try { await work(); } catch (error) { if (error.name !== 'AbortError') toast(error.message || 'The operation failed. Your drafts were kept.', true); }
  finally { state.busy = false; renderAll({ resetEditor: false }); }
}
function releaseImages() { for (const url of objectUrls) URL.revokeObjectURL(url); objectUrls.clear(); }
function refreshIndex() { state.index = buildKnowledgeIndex(state.notes); }
function flushMetadata() {
  clearTimeout(editTimer);
  for (const note of pendingMetadata) Object.assign(note, parseNote(note.path, note.content));
  pendingMetadata.clear(); refreshIndex();
}
function changeContent(note, content, fromEditor = false) {
  note.content = content; pendingMetadata.add(note); renderStatus();
  clearTimeout(editTimer);
  editTimer = setTimeout(() => { flushMetadata(); renderAll({ resetEditor: !fromEditor }); }, 180);
}

async function mountVault(vault) {
  const result = await vault.read((count) => { $('local-status').textContent = `Reading ${count} notes…`; });
  flushMetadata(); releaseImages();
  state.vault = vault; state.notes = result.notes; state.warnings = result.warnings; state.query = ''; state.tag = ''; state.recent = false; state.graph = false; state.collapsed.clear();
  state.selected = state.notes.has('Start here.md') ? 'Start here.md' : [...state.notes.keys()].sort((a, b) => a.localeCompare(b))[0] || null;
  $('search').value = ''; refreshIndex(); renderAll();
  toast(`${state.notes.size} notes opened${state.warnings.length ? `; ${state.warnings.length} scan warning(s).` : '.'}`);
}
async function openVault() {
  if (blocked() || !await canLeave()) return;
  if (typeof window.showDirectoryPicker !== 'function') { $('folder-input').click(); return; }
  // The picker runs directly from a user gesture, before asynchronous scanning.
  try { const handle = await window.showDirectoryPicker({ id: 'ekphos-vault', mode: 'readwrite' }); await busy(() => mountVault(new DirectoryVault(handle))); }
  catch (error) { if (error.name !== 'AbortError') toast(`${error.message} You can also use “Import read-only”.`, true); }
}
async function importFolder() { if (!blocked() && await canLeave()) $('folder-input').click(); }
async function openDemo() { if (!blocked() && await canLeave()) await busy(() => mountVault(new DemoVault())); }
async function refreshVault() {
  if (state.vault?.mode !== 'disk') return;
  await busy(async () => {
    flushMetadata(); const fresh = await state.vault.read();
    state.notes = reconcileRefresh(state.notes, fresh.notes); state.warnings = fresh.warnings;
    if (!state.notes.has(state.selected)) state.selected = [...state.notes.keys()][0] || null;
    refreshIndex(); renderAll(); toast('Refreshed from disk. Unsaved drafts were preserved.');
  });
}
function selectNote(path, heading = '') {
  if (!state.notes.has(path)) return;
  flushMetadata(); const changed = state.selected !== path;
  state.selected = path; state.graph = false;
  const parents = path.split('/').slice(0, -1);
  parents.forEach((_, i) => state.collapsed.delete(parents.slice(0, i + 1).join('/')));
  renderAll();
  document.body.classList.remove('sidebar-open'); $('toggle-sidebar').setAttribute('aria-expanded', 'false');
  if (changed) { $('preview').scrollTop = 0; $('editor').scrollTop = 0; }
  if (heading) goHeading(heading);
}
function setView(view) { state.view = view; remember('view', view); renderDocument(); renderStatus(); }
function goHeading(anchor) {
  if (state.view === 'edit') setView('read');
  let decoded = anchor;
  try { decoded = decodeURIComponent(anchor); } catch { /* Use literal anchor. */ }
  const wanted = slug(decoded);
  const heading = current()?.headings.find((h) => h.id === wanted || slug(h.text) === wanted);
  if (!heading) { toast(`Heading “${decoded}” was not found.`); return; }
  requestAnimationFrame(() => {
    const element = $(`heading-${heading.id}`);
    if (element) { element.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); element.tabIndex = -1; element.focus({ preventScroll: true }); }
  });
}
function followLink(target) {
  const note = current(); if (!note) return;
  const result = state.index.resolve(target, note.path);
  if (result.note) { selectNote(result.note.path, result.heading); return; }
  if (result.matches.length > 1) { commandCandidates = result.matches; showCommand(); return; }
  const raw = target.split('#')[0];
  const path = resolvePath(raw, note.path);
  if (!path || /\.[a-z0-9]+$/i.test(path) && !/\.(md|markdown)$/i.test(path)) { toast('This link does not resolve to a supported Markdown note.', true); return; }
  showNewNote(path);
}
function showNewNote(path = '') {
  if (blocked()) return;
  if (!state.vault) { toast('Open a folder or the example vault first.'); return; }
  $('new-path').value = path; $('new-error').textContent = ''; $('new-dialog').showModal(); $('new-path').focus();
}
function createNote(event) {
  event.preventDefault();
  try {
    const path = validateNotePath($('new-path').value);
    if ([...state.notes.keys()].some((p) => fold(p) === fold(path))) throw new Error('A note with this path already exists. Use a different name.');
    const content = `# ${stem(path)}\n\n`;
    const note = { ...parseNote(path, content), savedContent: '', isNew: true, handle: null, modified: Date.now() };
    state.notes.set(path, note); state.query = ''; state.tag = ''; $('search').value = ''; $('new-dialog').close();
    state.view = 'edit'; selectNote(path); $('editor').focus(); $('editor').setSelectionRange(content.length, content.length);
  } catch (error) { $('new-error').textContent = error.message; }
}
async function saveCurrent() {
  const note = current();
  if (!note || !isDirty(note) || blocked()) return;
  if (state.vault?.mode !== 'disk') { toast('This vault is not writable. Download a Markdown copy to keep your edits.'); return; }
  flushMetadata(); const snapshot = note.content; state.saving = note.path; renderStatus();
  try {
    const result = await state.vault.save(note, snapshot); Object.assign(note, result); delete note.error;
    toast(isDirty(note) ? 'Saved the captured version. Your newer edits are still unsaved.' : `Saved ${stem(note.path)}.`);
  } catch (error) { note.error = error.message; if (error.code === 'conflict') note.diskChanged = true; toast(error.message, true); }
  finally { state.saving = null; renderAll({ resetEditor: false }); }
}
function downloadCurrent() {
  const note = current(); if (!note) return;
  const url = URL.createObjectURL(new Blob([note.content], { type: 'text/markdown;charset=utf-8' }));
  const anchor = el('a'); anchor.href = url; anchor.download = note.path.split('/').at(-1); document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
  toast('Downloaded a copy. The original file and draft status are unchanged.');
}
async function reloadCurrent() {
  const note = current();
  if (!note?.handle || state.vault?.mode !== 'disk' || blocked()) return;
  if (isDirty(note) && !await confirmAction('Replace this draft with the disk version?', 'Your current draft will be discarded. Download a copy first to keep both versions.', 'Reload from disk')) return;
  await busy(async () => {
    const fresh = await loadNote(note.path, await note.handle.getFile(), note.handle);
    pendingMetadata.delete(note); state.notes.set(note.path, fresh); refreshIndex(); renderAll(); toast('Reloaded the disk version.');
  });
}

function renderNavigation() {
  $('vault-name').textContent = state.vault?.name || 'Your workspace';
  $('vault-kind').textContent = { disk: 'Local folder · read / write', readonly: 'Imported snapshot · read-only', demo: 'Example · not saved to disk' }[state.vault?.mode] || 'Choose a local folder';
  $('note-count').textContent = state.notes.size;
  $('search').disabled = !state.vault;
  for (const [id, active] of [['all-notes', !state.recent && !state.graph], ['recent-notes', state.recent && !state.graph], ['open-graph', state.graph]]) { $(id).classList.toggle('active', active); $(id).setAttribute('aria-pressed', String(active)); }
  if (!state.vault) return;
  const notes = filtered();
  $('files-label').textContent = state.query || state.tag ? `${notes.length} MATCHING NOTES` : state.recent ? 'RECENTLY MODIFIED' : 'YOUR NOTES';
  const tree = $('file-tree'); tree.replaceChildren();
  const noteButton = (note, showPath = false) => {
    const button = el('button', '', `note-button${note.path === state.selected ? ' current' : ''}`); button.type = 'button'; button.dataset.note = note.path; button.title = note.path;
    if (note.path === state.selected) button.setAttribute('aria-current', 'page');
    button.append(icon('note')); const label = el('span', note.title); if (showPath) label.append(el('small', note.path)); button.append(label);
    if (isDirty(note)) { const dot = el('i'); dot.setAttribute('aria-label', 'Unsaved changes'); button.append(dot); }
    return button;
  };
  const visible = notes.slice(0, 400);
  if (state.query || state.tag || state.recent) visible.forEach((note) => tree.append(noteButton(note, true)));
  else {
    const root = { folders: new Map(), notes: [] };
    for (const note of visible) { let parent = root; for (const segment of note.path.split('/').slice(0, -1)) { if (!parent.folders.has(segment)) parent.folders.set(segment, { folders: new Map(), notes: [] }); parent = parent.folders.get(segment); } parent.notes.push(note); }
    const append = (parent, node, prefix = '') => {
      for (const [name, folder] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
        const path = prefix + name, details = el('details'); details.open = !state.collapsed.has(path);
        const summary = el('summary'); summary.append(icon('folder'), el('span', name)); details.append(summary);
        const children = el('div', '', 'folder-children'); append(children, folder, path + '/'); details.append(children); parent.append(details);
        details.addEventListener('toggle', () => { if (details.open) state.collapsed.delete(path); else state.collapsed.add(path); });
      }
      node.notes.forEach((note) => parent.append(noteButton(note)));
    };
    append(tree, root);
  }
  if (!notes.length) tree.append(el('p', state.notes.size ? 'No matching notes. Clear the search or tag filter.' : 'No Markdown notes yet. Create your first note with +.', 'sidebar-empty'));
  if (notes.length > visible.length) tree.append(el('p', `Showing ${visible.length} of ${notes.length}. Search to narrow the list.`, 'sidebar-empty'));
  const tags = new Map();
  for (const note of state.notes.values()) for (const tag of new Set(note.tags.map(fold))) tags.set(tag, (tags.get(tag) || 0) + 1);
  $('tags').replaceChildren();
  for (const [tag, count] of [...tags].sort(([a], [b]) => a.localeCompare(b))) { const button = el('button', `#${tag}`, `tag${tag === state.tag ? ' active' : ''}`); button.type = 'button'; button.dataset.tag = tag; button.setAttribute('aria-pressed', String(tag === state.tag)); button.append(el('span', count)); $('tags').append(button); }
  if (!tags.size) $('tags').append(el('span', 'Add #tags or frontmatter tags.', 'muted'));
  $('clear-tag').hidden = !state.tag;
}
function renderStatus() {
  const note = current(), dirty = note && isDirty(note), mode = state.vault?.mode;
  document.body.classList.toggle('busy', state.busy); $('document-pane').setAttribute('aria-busy', String(state.busy));
  for (const id of ['open-vault', 'welcome-open', 'banner-open', 'import-folder', 'explore-demo']) $(id).disabled = state.busy || !!state.saving;
  $('new-note').disabled = !state.vault || state.busy || !!state.saving;
  $('refresh-vault').disabled = mode !== 'disk' || state.busy || !!state.saving;
  $('save-note').disabled = !note || !dirty || mode !== 'disk' || state.busy || !!state.saving;
  $('save-note').title = mode !== 'disk' ? 'Open a writable local vault to save; use Download to keep a copy.' : 'Save to the original Markdown file (Ctrl / ⌘ S)';
  $('reload-note').disabled = !note?.handle || mode !== 'disk' || state.busy || !!state.saving;
  $('download-note').disabled = !note;
  $('save-status').textContent = state.saving === note?.path ? 'Saving…' : note?.diskChanged ? 'Disk conflict' : dirty ? 'Unsaved draft' : mode === 'demo' ? 'Example note' : mode === 'readonly' ? 'Read-only' : 'Saved';
  $('save-status').classList.toggle('dirty', !!dirty);
  $('word-count').textContent = note ? `${note.words.toLocaleString()} words · Markdown` : 'Markdown, without the noise.';
  $('draft-count').textContent = drafts().length ? `${drafts().length} draft(s)` : '';
  $('local-status').textContent = state.busy ? 'Reading local files…' : mode === 'disk' ? 'Local folder · explicit save' : mode === 'readonly' ? 'Read-only snapshot' : mode === 'demo' ? 'Example · in this tab only' : 'Local-first workspace';
  $('scan-report').hidden = !state.warnings.length; $('scan-report').textContent = `${state.warnings.length} scan warning(s)`;
  $('document-alert').hidden = !note?.error && !note?.diskChanged;
  $('document-alert').textContent = note?.error || (note?.diskChanged ? 'The disk version changed or disappeared. Download your draft before reloading the disk version; refresh never overwrites your draft.' : '');
  document.title = note ? `${dirty ? '• ' : ''}${note.title} — Ekphos` : 'Ekphos — Your local research workspace';
}
function renderDocument(resetEditor = true) {
  const note = current(), hasVault = !!state.vault;
  $('welcome').hidden = hasVault; $('empty-note').hidden = !hasVault || !!note || state.graph;
  $('document').hidden = !hasVault || !note || state.graph; $('document-toolbar').hidden = !note || state.graph; $('graph-view').hidden = !hasVault || !state.graph;
  $('current-path').textContent = state.graph ? 'Knowledge graph' : note?.path || (hasVault ? state.vault.name : 'Welcome to Ekphos');
  $('session-banner').hidden = !hasVault || state.vault.mode === 'disk';
  $('session-message').textContent = state.vault?.mode === 'demo' ? 'EXAMPLE VAULT · Changes exist only in this tab.' : 'READ-ONLY SNAPSHOT · Edit drafts here; download copies to keep them.';
  if (!note) { releaseImages(); $('preview').replaceChildren(); $('editor').value = ''; return; }
  $('document').dataset.view = state.view;
  document.querySelectorAll('[data-view]').forEach((button) => { if (button.tagName === 'BUTTON') button.setAttribute('aria-pressed', String(button.dataset.view === state.view)); });
  if (resetEditor && $('editor').value !== note.content.replace(/\r\n|\r/g, '\n')) $('editor').value = note.content;
  $('reading-time').textContent = `${Math.max(1, Math.ceil(note.words / 220))} MIN READ`;
  const oldScroll = $('preview').scrollTop;
  releaseImages(); const generation = ++previewGeneration;
  $('preview').innerHTML = renderMarkdown(note); $('preview').scrollTop = oldScroll;
  for (const link of $('preview').querySelectorAll('[data-link]')) {
    const resolved = state.index.resolve(link.dataset.link, note.path);
    if (!resolved.note) { link.classList.add('unresolved'); link.title = resolved.matches.length ? 'Multiple notes match — choose a target' : 'Unresolved link — create a draft'; }
  }
  for (const placeholder of $('preview').querySelectorAll('[data-asset]')) {
    state.vault.asset(placeholder.dataset.asset, note.path).then((file) => {
      if (!file || generation !== previewGeneration) return;
      const url = URL.createObjectURL(file); objectUrls.add(url); const image = el('img'); image.alt = placeholder.dataset.alt || placeholder.dataset.asset; image.loading = 'lazy';
      image.addEventListener('error', () => { image.replaceWith(el('span', `Cannot decode image: ${image.alt}`, 'asset-placeholder')); URL.revokeObjectURL(url); objectUrls.delete(url); });
      image.src = url; placeholder.replaceWith(image);
    }).catch((error) => { if (generation === previewGeneration) placeholder.textContent = `Image unavailable: ${error.message}`; });
  }
}
function renderContext() {
  const note = current(); $('outline').replaceChildren(); $('backlinks').replaceChildren(); $('outgoing').replaceChildren(); $('missing-links').replaceChildren();
  $('outline-count').textContent = note?.headings.length || '';
  if (note) for (const heading of note.headings.slice(0, 80)) { const button = el('button', heading.text, `level-${heading.level}`); button.type = 'button'; button.dataset.heading = heading.id; $('outline').append(button); }
  if (!note?.headings.length) $('outline').append(el('p', 'Headings will appear here.', 'context-empty'));
  const incoming = state.index.backlinks.get(note?.path) || [], outgoing = state.index.outgoing.get(note?.path) || [];
  const noteLinks = (id, paths) => { for (const path of paths.slice(0, 50)) { const button = el('button'); button.type = 'button'; button.dataset.note = path; button.title = path; button.append(icon('note'), el('span', state.notes.get(path)?.title || stem(path))); $(id).append(button); } if (paths.length > 50) $(id).append(el('p', `${paths.length - 50} more — open the graph.`, 'context-empty')); };
  noteLinks('backlinks', incoming); noteLinks('outgoing', outgoing);
  if (!incoming.length) $('backlinks').append(el('p', 'No other notes point here yet.', 'context-empty'));
  if (!outgoing.length) $('outgoing').append(el('p', 'Add a [[wikilink]] to connect an idea.', 'context-empty'));
  $('backlink-count').textContent = incoming.length; $('outgoing-count').textContent = outgoing.length;
  const unresolved = state.index.unresolved.get(note?.path) || []; $('missing-section').hidden = !unresolved.length;
  for (const link of unresolved.slice(0, 30)) { const button = el('button', `${link.ambiguous ? 'Choose: ' : 'Create: '}${link.target}`); button.type = 'button'; button.dataset.link = link.target; $('missing-links').append(button); }
  $('properties').hidden = !note?.frontmatter; $('frontmatter').textContent = note?.frontmatter || '';
  renderGraph($('mini-graph'), true);
}
function renderGraph(svg, local = false) {
  svg.replaceChildren();
  let notes = local ? [] : filtered();
  const neighbors = new Set([state.selected, ...(state.index.backlinks.get(state.selected) || []), ...(state.index.outgoing.get(state.selected) || [])]);
  if (local) notes = [...neighbors].map((path) => state.notes.get(path)).filter(Boolean);
  notes.sort((a, b) => Number(b.path === state.selected) - Number(a.path === state.selected) || a.title.localeCompare(b.title));
  const total = notes.length, shown = notes.slice(0, local ? 12 : 80), width = local ? 280 : 900, height = local ? 200 : 620;
  if (local) $('connection-count').textContent = current() ? `${Math.max(0, total - 1)} connected notes${total > shown.length ? ` · showing ${shown.length - 1}` : ''}` : 'Ideas are better together.';
  else { $('graph-description').textContent = `${total} matching notes · ${state.index.edges.length} links in vault${total > shown.length ? ' · First 80 nodes shown; search to narrow the view.' : ''}`; svg.setAttribute('viewBox', state.graphBox.join(' ')); }
  if (!shown.length) { const text = svgEl('text', { x: width / 2, y: height / 2, fill: 'currentColor', stroke: 'none', 'text-anchor': 'middle' }); text.textContent = local ? 'Your next connection starts here' : 'No matching notes. Clear the search or add a note.'; text.setAttribute('font-size', local ? 10 : 16); svg.append(text); return; }
  const positions = new Map();
  const selectedFirst = shown[0]?.path === state.selected;
  shown.forEach((note, i) => {
    if (selectedFirst && !i) { positions.set(note.path, { x: width / 2, y: height / 2 }); return; }
    const index = i - Number(selectedFirst), count = shown.length - Number(selectedFirst);
    const ring = !local && count > 18 ? (index % 2 ? .67 : 1) : 1;
    const angle = -Math.PI / 2 + index * Math.PI * 2 / Math.max(1, count);
    positions.set(note.path, { x: width / 2 + Math.cos(angle) * width * (local ? .32 : .37) * ring, y: height / 2 + Math.sin(angle) * height * .34 * ring });
  });
  for (const edge of state.index.edges) { const a = positions.get(edge.source), b = positions.get(edge.target); if (a && b) svg.append(svgEl('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'graph-edge' })); }
  for (const note of shown) {
    const { x, y } = positions.get(note.path), selected = note.path === state.selected;
    const group = svgEl('g', { class: `graph-node${selected ? ' selected' : ''}`, 'data-note': note.path, tabindex: 0, role: 'button', 'aria-label': `Open ${note.title}` });
    const title = svgEl('title'); title.textContent = note.path;
    const circle = svgEl('circle', { cx: x, cy: y, r: local ? (selected ? 6 : 4) : (selected ? 10 : 7) });
    const text = svgEl('text', { x, y: y + (local ? 17 : 25) }); const max = local ? 17 : 26; text.textContent = note.title.length > max ? note.title.slice(0, max - 1) + '…' : note.title;
    if (local) text.setAttribute('font-size', 9);
    group.append(title, circle, text); svg.append(group);
  }
}
function renderAll({ resetEditor = true } = {}) { renderNavigation(); renderDocument(resetEditor); renderContext(); if (state.graph) renderGraph($('graph-canvas')); renderStatus(); }
function openGraph() { if (!state.vault) { toast('Open a vault first to explore connections.'); return; } flushMetadata(); state.graph = true; renderAll(); document.body.classList.remove('sidebar-open'); $('toggle-sidebar').setAttribute('aria-expanded', 'false'); }
function toggleTheme() { const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'; applyTheme(theme); remember('theme', theme); }
function applyTheme(theme) { document.documentElement.dataset.theme = theme; $('theme').setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`); }
function toggleFocus() { const enabled = document.body.classList.toggle('focus-mode'); $('focus-mode').setAttribute('aria-pressed', String(enabled)); }
function toggleContext(close = false) {
  const narrow = matchMedia('(max-width: 1150px)').matches;
  const enabled = close ? false : narrow ? !document.body.classList.contains('context-visible') : document.body.classList.contains('context-hidden');
  document.body.classList.toggle('context-hidden', !enabled); document.body.classList.toggle('context-visible', enabled); $('toggle-context').setAttribute('aria-expanded', String(enabled));
  if (close) $('toggle-context').focus();
}

function showCommand() { $('command-title').textContent = commandCandidates ? 'Choose the intended note' : 'Jump to anything'; $('command-input').value = ''; commandIndex = 0; updateCommand(); $('command-dialog').showModal(); $('command-input').focus(); }
function updateCommand() {
  const query = fold($('command-input').value.trim());
  const actions = commandCandidates ? [] : [
    { label: 'Open a local vault', detail: 'Choose a folder on your device', action: openVault, icon: 'folder' },
    { label: 'New note', detail: 'Create a Markdown draft', action: () => showNewNote(), icon: 'plus' },
    { label: 'Knowledge graph', detail: 'Explore connections', action: openGraph, icon: 'graph' },
    { label: 'Save current note', detail: 'Explicitly write to the original file', action: saveCurrent, icon: 'save' },
    { label: 'Switch theme', detail: 'Light / dark appearance', action: toggleTheme, icon: 'theme' },
    { label: 'Toggle focus mode', detail: 'Make more room for the document', action: toggleFocus, icon: 'focus' },
    { label: 'Refresh from disk', detail: 'Keep drafts and re-read the vault', action: refreshVault, icon: 'refresh' },
  ];
  const notes = (commandCandidates || searchNotes(state.notes, query)).filter((n) => !commandCandidates || fold(`${n.title} ${n.path}`).includes(query)).slice(0, 40).map((note) => ({ label: note.title, detail: note.path, icon: 'note', action: () => selectNote(note.path) }));
  commandItems = [...notes, ...actions.filter((a) => fold(a.label).includes(query))]; commandIndex = Math.min(commandIndex, Math.max(0, commandItems.length - 1));
  $('command-results').replaceChildren();
  commandItems.forEach((item, i) => { const button = el('button', '', `command-option${i === commandIndex ? ' active' : ''}`); button.type = 'button'; button.id = `command-item-${i}`; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(i === commandIndex)); button.tabIndex = -1; button.dataset.command = i; button.append(icon(item.icon)); const label = el('span', item.label); label.append(el('small', item.detail)); button.append(label); $('command-results').append(button); });
  if (!commandItems.length) $('command-results').append(el('p', 'No matching notes or commands.', 'sidebar-empty'));
  if (commandItems.length) $('command-input').setAttribute('aria-activedescendant', `command-item-${commandIndex}`); else $('command-input').removeAttribute('aria-activedescendant');
}
function runCommand(index) { const item = commandItems[index]; if (!item) return; $('command-dialog').close(); commandCandidates = null; item.action(); }
function formatEditor(kind) {
  const note = current(); if (!note) return;
  if (state.view === 'read') setView('edit');
  const editor = $('editor'), start = editor.selectionStart, end = editor.selectionEnd, selected = editor.value.slice(start, end);
  const value = { heading: `## ${selected || 'Heading'}`, bold: `**${selected || 'bold text'}**`, link: `[[${selected || 'Note name'}]]`, task: `- [ ] ${selected || 'A next step'}` }[kind];
  if (!value) return;
  const lineStart = editor.value.lastIndexOf('\n', start - 1) + 1;
  editor.setRangeText((['heading', 'task'].includes(kind) && start !== lineStart ? '\n' : '') + value, start, end, 'end'); editor.focus(); editor.dispatchEvent(new Event('input', { bubbles: true }));
}

for (const id of ['open-vault', 'welcome-open', 'banner-open']) $(id).addEventListener('click', openVault);
$('import-folder').addEventListener('click', importFolder); $('explore-demo').addEventListener('click', openDemo);
$('folder-input').addEventListener('change', async (event) => { const files = [...event.target.files]; event.target.value = ''; if (files.length) await busy(() => mountVault(new ImportedVault(files))); });
$('refresh-vault').addEventListener('click', refreshVault); $('new-note').addEventListener('click', () => showNewNote()); $('empty-create').addEventListener('click', () => showNewNote()); $('new-form').addEventListener('submit', createNote);
$('save-note').addEventListener('click', saveCurrent); $('download-note').addEventListener('click', downloadCurrent); $('reload-note').addEventListener('click', reloadCurrent);
$('search').addEventListener('input', () => { state.query = $('search').value; renderNavigation(); if (state.graph) renderGraph($('graph-canvas')); });
$('all-notes').addEventListener('click', () => { state.recent = false; state.graph = false; state.query = ''; state.tag = ''; $('search').value = ''; renderAll(); });
$('recent-notes').addEventListener('click', () => { state.recent = true; state.graph = false; renderAll(); });
$('open-graph').addEventListener('click', openGraph); $('expand-graph').addEventListener('click', openGraph);
$('clear-tag').addEventListener('click', () => { state.tag = ''; renderNavigation(); if (state.graph) renderGraph($('graph-canvas')); });
$('tags').addEventListener('click', (event) => { const tag = event.target.closest('[data-tag]')?.dataset.tag; if (tag !== undefined) { state.tag = state.tag === tag ? '' : tag; renderNavigation(); if (state.graph) renderGraph($('graph-canvas')); } });
$('editor').addEventListener('input', () => { const note = current(); if (note) changeContent(note, $('editor').value.replace(/\n/g, note.eol), true); });
$('editor').addEventListener('keydown', (event) => { if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.shiftKey) { event.preventDefault(); $('editor').setRangeText('  ', $('editor').selectionStart, $('editor').selectionEnd, 'end'); $('editor').dispatchEvent(new Event('input', { bubbles: true })); } });
$('preview').addEventListener('change', (event) => { const task = event.target.closest('[data-task]'); if (!task || !current()) return; const line = task.dataset.task; changeContent(current(), toggleTask(current().content, Number(line), task.checked)); setTimeout(() => $('preview').querySelector(`[data-task="${line}"]`)?.focus({ preventScroll: true }), 220); });
document.addEventListener('click', (event) => {
  const close = event.target.closest('[data-close]'); if (close) { $(close.dataset.close).close(); return; }
  const node = event.target.closest('[data-note]'); if (node) { selectNote(node.dataset.note); return; }
  const link = event.target.closest('[data-link]'); if (link) { followLink(link.dataset.link); return; }
  const heading = event.target.closest('[data-heading]'); if (heading) { goHeading(heading.dataset.heading); return; }
  const view = event.target.closest('button[data-view]'); if (view) { setView(view.dataset.view); return; }
  const format = event.target.closest('[data-format]'); if (format) formatEditor(format.dataset.format);
});
$('confirm-no').addEventListener('click', () => settleConfirm(false)); $('confirm-yes').addEventListener('click', () => settleConfirm(true)); $('confirm-dialog').addEventListener('cancel', (event) => { event.preventDefault(); settleConfirm(false); });
$('theme').addEventListener('click', toggleTheme); $('focus-mode').addEventListener('click', toggleFocus); $('toggle-context').addEventListener('click', () => toggleContext()); $('close-context').addEventListener('click', () => toggleContext(true));
$('toggle-sidebar').addEventListener('click', () => { const open = document.body.classList.toggle('sidebar-open'); $('toggle-sidebar').setAttribute('aria-expanded', String(open)); });
$('brand').addEventListener('click', (event) => { event.preventDefault(); if (state.vault) $('all-notes').click(); });
$('open-command').addEventListener('click', () => { commandCandidates = null; showCommand(); });
$('command-dialog').addEventListener('close', () => { commandCandidates = null; });
$('command-input').addEventListener('input', () => { commandIndex = 0; updateCommand(); });
$('command-results').addEventListener('click', (event) => { const button = event.target.closest('[data-command]'); if (button) runCommand(Number(button.dataset.command)); });
$('command-input').addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); commandIndex = (commandIndex + (event.key === 'ArrowDown' ? 1 : -1) + Math.max(1, commandItems.length)) % Math.max(1, commandItems.length); updateCommand(); $(`command-item-${commandIndex}`)?.scrollIntoView({ block: 'nearest' }); }
  if (event.key === 'Enter') { event.preventDefault(); runCommand(commandIndex); }
});
$('scan-report').addEventListener('click', () => showInfo('Vault scan report', `Some entries were not loaded. Originals were not changed.\n\n${state.warnings.join('\n')}`));
$('help').addEventListener('click', () => showInfo('A workspace that stays yours', 'OPEN\nUse Open a local vault in a browser with the directory picker (typically desktop Chrome or Edge). Other browsers can import a read-only folder snapshot. Run this UI on localhost or HTTPS, not file://.\n\nWRITE\nSave explicitly with Ctrl / ⌘ S. Drafts stay in this tab when you switch notes, but do not survive closing the tab or a browser crash. Download keeps a copy without changing the original. Refresh re-reads disk and preserves drafts. Saving checks for external content changes; it is not a cross-application file lock. Avoid simultaneous edits in the terminal and browser.\n\nSHORTCUTS\nCtrl / ⌘ K — notes and commands\nCtrl / ⌘ S — save\nCtrl / ⌘ Shift N — new note\nCtrl / ⌘ Shift F — search all notes\nEscape — close a dialog or navigation panel\nTab in editor — insert two spaces (Shift Tab leaves the editor)\n\nMARKDOWN\nHeadings, paragraphs, emphasis, code fences, lists, tasks, simple tables, links, wikilinks, and local raster images. Raw HTML is shown as text; remote images, math typesetting, canvas, bases, and TUI settings are not implemented here. Unknown source syntax is preserved when saved.\n\nPRIVACY & LIMITS\nNo account, analytics, CDN, network API, or uploaded notes. Only theme/view preferences are stored in localStorage. Notes are indexed in browser memory: up to 2,000 notes, 1 MiB per note, 32 MiB total, 15,000 scanned entries, 16 folder levels. Hidden folders and common build/vendor folders are skipped. Scan warnings are shown, never hidden. Graphs display up to 80 nodes.'));

function zoomGraph(factor) { const [x, y, w, h] = state.graphBox, next = Math.max(220, Math.min(2700, w * factor)), scale = next / w; state.graphBox = [x + (w - next) / 2, y + (h - h * scale) / 2, next, h * scale]; $('graph-canvas').setAttribute('viewBox', state.graphBox.join(' ')); }
$('zoom-in').addEventListener('click', () => zoomGraph(.8)); $('zoom-out').addEventListener('click', () => zoomGraph(1.25)); $('zoom-reset').addEventListener('click', () => { state.graphBox = [0, 0, 900, 620]; $('graph-canvas').setAttribute('viewBox', state.graphBox.join(' ')); });
let pan = null;
$('graph-canvas').addEventListener('pointerdown', (event) => { if (event.button !== 0 || event.target.closest('[data-note]')) return; pan = { x: event.clientX, y: event.clientY, box: [...state.graphBox] }; $('graph-canvas').setPointerCapture(event.pointerId); });
$('graph-canvas').addEventListener('pointermove', (event) => { if (!pan) return; const rect = $('graph-canvas').getBoundingClientRect(), ratio = Math.max(pan.box[2] / rect.width, pan.box[3] / rect.height); state.graphBox = [pan.box[0] - (event.clientX - pan.x) * ratio, pan.box[1] - (event.clientY - pan.y) * ratio, pan.box[2], pan.box[3]]; $('graph-canvas').setAttribute('viewBox', state.graphBox.join(' ')); });
for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) $('graph-canvas').addEventListener(event, () => { pan = null; });
document.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('g[data-note]')) { event.preventDefault(); selectNote(event.target.dataset.note); return; }
  if (document.querySelector('dialog[open]')) return;
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === 'k') { event.preventDefault(); commandCandidates = null; showCommand(); }
  else if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); saveCurrent(); }
  else if (modifier && event.shiftKey && event.key.toLowerCase() === 'n') { event.preventDefault(); showNewNote(); }
  else if (modifier && event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); if (!state.vault) return; if (matchMedia('(max-width: 760px)').matches) { document.body.classList.add('sidebar-open'); $('toggle-sidebar').setAttribute('aria-expanded', 'true'); } $('search').focus(); }
  else if (event.key === '/' && !/INPUT|TEXTAREA/.test(event.target.tagName)) { event.preventDefault(); if (!state.vault) return; if (matchMedia('(max-width: 760px)').matches) $('toggle-sidebar').click(); $('search').focus(); }
  else if (event.key === 'Escape') { document.body.classList.remove('sidebar-open', 'context-visible'); $('toggle-sidebar').setAttribute('aria-expanded', 'false'); if (matchMedia('(max-width: 1150px)').matches) $('toggle-context').setAttribute('aria-expanded', 'false'); }
});
window.addEventListener('beforeunload', (event) => { if (drafts().length || state.saving) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', releaseImages);
applyTheme(pref('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') === 'dark' ? 'dark' : 'light');
$('command-key').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘ K' : 'Ctrl K';
$('toggle-context').setAttribute('aria-expanded', String(!matchMedia('(max-width: 1150px)').matches));
if (typeof window.showDirectoryPicker !== 'function') { $('welcome-open').lastChild.textContent = 'Import a local folder'; $('compatibility-note').textContent = 'This browser imports read-only folder snapshots. Edit and download copies, or use desktop Chrome / Edge for direct saves. Nothing is uploaded.'; }
renderAll();
