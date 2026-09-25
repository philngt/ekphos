# Ekphos Web

An optional, local-first browser workspace for an existing Ekphos Markdown vault.
The Rust terminal application is unchanged. This is a separate frontend, not a
terminal skin, a hosted service, or a new `ekphos --web` command.

## Run

From the repository root, with Python 3 installed:

```sh
python3 -m http.server 4173 --bind 127.0.0.1 --directory web
```

Visit **http://127.0.0.1:4173** and choose **Open vault**. Select the actual folder
containing your Markdown notes. The HTTP server serves only the frontend assets;
it does not receive vault contents or expose a filesystem API. Keep it bound to
loopback. Stop it with Ctrl+C. Opening `index.html` using `file://` is not supported.

No Rust build, npm install, CDN, account, API key, telemetry, or runtime framework
is required. Once the assets are loaded, the workspace makes no network requests.
External links open only when clicked, in a separate tab.

### Browser modes

| Mode | How it starts | Read | Edit in this tab | Write originals |
| --- | --- | --- | --- | --- |
| Local folder | Open vault, when `showDirectoryPicker` is available | Yes | Yes | Explicit Save, with browser permission |
| Imported folder | Folder input fallback in other browsers | Snapshot | Yes | No; Download copy instead |
| Example | Explicitly choose Explore example vault | Five bundled example notes | Yes | No; Download copy instead |

Use a current desktop Chrome or Edge for direct folder read/write. File System
Access availability varies by browser, platform, policy, and secure context. The
picker must be invoked by a user gesture; cancelling is not an error. Browsers
without that API use a clearly labelled, read-only directory import. Import is a
snapshot: reopen the folder to pick up later disk changes. Mobile is a responsive
reading/editing layout, not a promise of native mobile filesystem integration.

References: [showDirectoryPicker](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)
and [createWritable](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable).

## Workspace

- Collapsible folder explorer, recent notes, full-text search, and `#tag` filters.
- Read / Split / Edit views, source formatting helpers, local raster images, and
  task checkboxes that update their original Markdown source lines.
- Clickable `[[wikilinks]]`, `[[note#heading|label]]`, relative Markdown links,
  frontmatter title/tags/aliases, outline, outgoing links, backlinks, and a graph.
  Ambiguous links ask which note to open instead of silently choosing one.
- New-note dialog with nested paths and collision validation. New notes remain
  drafts until Save. No delete, rename, or move operations are provided.
- Keyboard command palette, focus mode, light/dark themes, responsive drawers,
  accessible dialog controls, visible focus, and reduced-motion support.

The global graph shows at most 80 nodes, with pan, zoom, reset, keyboard activation,
and a visible truncation notice. The local graph shows up to 12 neighboring notes.
Search narrows larger vaults; the explorer caps the rendered result list at 400
notes. These are deliberately bounded views, not claims that the entire graph or
all matching results are always on screen.

### Shortcuts

| Shortcut | Action |
| --- | --- |
| Ctrl/Cmd + K | Open the command palette |
| Ctrl/Cmd + S | Save the active note in local-folder mode |
| Ctrl/Cmd + Shift + N | New draft |
| Ctrl/Cmd + Shift + F | Focus vault search |
| `/`, outside a text input | Focus vault search |
| Escape | Close a dialog or drawer |
| Arrow keys / Enter in palette | Select / run an action |

Native browser shortcuts may take precedence in some environments. Every primary
action is also available through a visible button.

## Drafts, saving, and shared use with the TUI

The selected directory is the shared source of truth. There is no database or
migration. Save compares the current file's full UTF-8 contents against the last
loaded/saved baseline before opening a writer, and checks again after opening it.
A mismatch reports a conflict and retains the draft. Download the draft before
explicitly reloading the disk version to reconcile it. Refresh updates clean notes
and preserves dirty drafts and their comparison baselines.

Writes use `createWritable({ mode: 'exclusive' })` and commit on close. A failed
write is reported, not marked as saved. A newer edit made while Save is running is
not replaced by the older saved snapshot. Browser Web Locks serialize cooperating
tabs when available. **This is not an operating-system lock or an atomic
compare-and-swap against a native editor.** An external process can still race the
last check and commit; avoid saving the same note simultaneously from the TUI and
the browser. There is no filesystem watcher; use Refresh after external edits.

A failed first save can leave newly created parent directories or an empty file.
The in-tab draft remains retryable. Existing paths, including empty files and
case-insensitive collisions, are rejected during new-note creation rather than
intentionally overwritten. Directory creation and file creation are not one
transaction; back up valuable vaults before trying a new editor.

Drafts are kept **only in memory**. Switching notes preserves them; changing vaults
asks for confirmation. Closing/reloading the page requests a browser warning where
supported, but a crash, forced close, or unavailable warning can lose drafts. Save
or Download copy before leaving. Download never marks the original as saved.
There is no auto-save, draft recovery, persistent vault permission, or background
sync. Only theme and layout preference are stored in localStorage when permitted.

## Supported Markdown and boundaries

The preview is an intentionally limited, dependency-free Markdown subset: ATX
headings, fenced code, paragraphs, basic emphasis, flat lists, task lists, quotes,
simple pipe tables, links, and images. Frontmatter supports simple title, tags,
and aliases (scalar or simple lists), not general YAML. UTF-8 decoding is strict;
invalid files are skipped with a warning rather than rewritten with replacement
characters. The editor keeps original source text; preview checkbox edits preserve
line endings and the UTF-8 BOM.

This is **not full CommonMark, full Obsidian compatibility, or TUI feature parity**.
Nested Markdown constructs, advanced YAML, live syntax highlighting, LaTeX,
Canvas, Bases, plugins, embeds/transclusion, Vim/Helix editing, and TUI configuration
are not implemented here. Raw HTML is shown as text, not executed. The Rust parser
and services are not called by the browser; the pure browser index is an adapter
for ordinary Markdown files and may differ on advanced syntax.

### Security and resource limits

The application escapes generated HTML, permits only HTTP(S)/mailto external
links, refuses script URLs and paths above the selected root, and does not fetch
remote images. Images are loaded on demand only from the selected vault and only
for PNG, JPEG, GIF, WebP, BMP, and AVIF; SVG is intentionally excluded. A restrictive
Content Security Policy forbids network connections, inline scripts, objects, and
forms. No secrets or notes are sent to a server. Selecting a folder is still an
explicit local permission grant to this page: serve only a copy you trust.

Vault loading is capped at 2,000 notes, 1 MiB per note, 32 MiB total note bytes,
15,000 inspected entries, and 16 nested directory levels. Local images are capped
at 8 MiB. Dotfiles/directories, `node_modules`, `target`, and `vendor` are skipped.
Skipped/unreadable files and limit truncation are shown as warnings. Oversized
saves are rejected before writing. Large vaults should be opened as smaller
subfolders; this version does not implement a background search index.

## Code layout

```text
web/
  index.html              Accessible shell, dialogs, strict CSP
  styles.css              Responsive light/dark visual system
  icon.svg                Local application mark
  core.mjs                Pure parsing, safe rendering, links, graph, search
  vault.mjs               Directory / imported / demo adapters, save safeguards
  app.mjs                 UI state, drafts, commands, editor and graph interactions
  tests/core.test.mjs      Parsing, indexing, paths, rendering and checkbox tests
  tests/vault.test.mjs     Filesystem adapter / refresh / conflict tests
  tests/fake-fs.mjs        In-memory File System Access test doubles
  tests/browser_smoke.py   Playwright DOM integration tests
```

Keep filesystem access in `vault.mjs`, pure domain logic in `core.mjs`, and DOM
operations in `app.mjs`. Extending the Markdown subset should include parser,
renderer, link-index, and malicious-input regression tests. Future native packaging
can replace the vault adapter instead of coupling components to filesystem APIs.

## Validation

Node 20+ is needed only for the logic tests and syntax checks; no npm dependencies
are installed:

```sh
cd web
npm run check
npm test
```

Optional browser tests require Python 3, the `playwright` Python package, and a
Chromium installation:

```sh
python3 -m pip install playwright
python3 -m playwright install chromium
python3 tests/browser_smoke.py
# Or use an existing executable:
CHROMIUM_PATH=/usr/bin/chromium python3 tests/browser_smoke.py
```

The initial implementation was validated with **44 Node tests and 12 Chromium DOM
integration tests**. The browser harness inlines the actual modules/styles into an
in-memory document with SHA-256 CSP hashes. It stubs File System Access handles,
but exercises the real application DOM and adapter logic, including read-only
folder import, saving failures, conflicts, drafts, task toggles, malicious markup,
responsive layouts, keyboard navigation, and edits during a pending save. No
application-specific testing hooks are exposed.

**Not covered by that harness:** an OS-native folder picker, actual permission
prompts/revocation, browser-specific disk commit semantics, or concurrency with a
real TUI process. Before relying on direct writes, manually verify on the target
OS/browser with a disposable vault: open/cancel, edit/save/reopen, deny permission,
edit the same note externally, Refresh with a draft, close with a draft, local
images, and new-note collision handling. The Rust test suite is separate; no Rust
source or dependency is changed by this companion.
