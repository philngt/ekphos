import { parseNote, isMarkdown, fold, resolvePath, validateNotePath, DEMO_NOTES } from './core.mjs';

export const LIMITS = Object.freeze({ notes: 2000, noteBytes: 1024 * 1024, totalBytes: 32 * 1024 * 1024, entries: 15000, depth: 16, imageBytes: 8 * 1024 * 1024 });
const raster = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
const ignored = (part) => part.startsWith('.') || ['node_modules', 'target', 'vendor'].includes(part);
export class VaultError extends Error { constructor(code, message) { super(message); this.name = 'VaultError'; this.code = code; } }
export const isDirty = (note) => note.isNew || note.content !== note.savedContent;

async function readText(file) {
  if (file.size > LIMITS.noteBytes) throw new VaultError('limit', 'Note exceeds the 1 MiB limit.');
  // Preserve a UTF-8 BOM and fail rather than silently replacing invalid bytes.
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await file.arrayBuffer());
}

export async function loadNote(path, file, handle = null) {
  const content = await readText(file);
  return { ...parseNote(path, content), savedContent: content, handle, modified: file.lastModified, isNew: false };
}

export class DirectoryVault {
  constructor(root) { this.root = root; this.name = root.name; this.mode = 'disk'; this.assets = new Map(); }
  async read(onProgress = () => {}) {
    const notes = new Map(), assets = new Map(), warnings = [];
    let bytes = 0, entries = 0, stopped = false;
    const walk = async (directory, prefix = '', depth = 0) => {
      if (depth > LIMITS.depth) { warnings.push(`${prefix}: folder depth limit reached.`); return; }
      for await (const handle of directory.values()) {
        if (stopped) break;
        if (++entries > LIMITS.entries) { warnings.push('Entry limit reached; not every file was scanned.'); stopped = true; break; }
        if (ignored(handle.name)) continue;
        const path = prefix + handle.name;
        try {
          if (handle.kind === 'directory') { await walk(handle, path + '/', depth + 1); continue; }
          if (raster.test(path)) { assets.set(path, { handle }); continue; }
          if (!isMarkdown(path)) continue;
          if (notes.size >= LIMITS.notes) { warnings.push('2,000-note limit reached; remaining notes were not loaded.'); stopped = true; break; }
          const file = await handle.getFile();
          if (file.size > LIMITS.noteBytes) { warnings.push(`${path}: exceeds 1 MiB.`); continue; }
          if (bytes + file.size > LIMITS.totalBytes) { warnings.push(`${path}: vault memory budget reached.`); stopped = true; break; }
          notes.set(path, await loadNote(path, file, handle)); bytes += file.size;
          if (notes.size % 25 === 0) { onProgress(notes.size); await new Promise((resolve) => setTimeout(resolve, 0)); }
        } catch (error) {
          if (error.name === 'NotAllowedError' || error.name === 'SecurityError') throw error;
          warnings.push(`${path}: ${error.message}`);
        }
      }
    };
    await walk(this.root);
    this.assets = assets;
    return { notes, warnings };
  }
  async save(note, content = note.content) {
    const save = async () => {
      if (new TextEncoder().encode(content).byteLength > LIMITS.noteBytes) throw new VaultError('limit', 'Draft exceeds 1 MiB. Download a copy; the original was not changed.');
      if (this.root.queryPermission && await this.root.queryPermission({ mode: 'readwrite' }) !== 'granted') {
        if (await this.root.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new VaultError('permission', 'Write permission was denied. Your draft is still in this tab.');
      }
      let handle = note.handle;
      if (note.isNew && !note.pendingCreation) {
        const path = validateNotePath(note.path), parts = path.split('/'), name = parts.pop();
        let directory = this.root;
        for (const part of parts) {
          for await (const child of directory.values()) {
            if (fold(child.name) === fold(part) && child.name !== part) throw new VaultError('conflict', `A folder named ${child.name} already exists with different capitalization.`);
          }
          directory = await directory.getDirectoryHandle(part, { create: true });
        }
        for await (const child of directory.values()) {
          if (fold(child.name) === fold(name)) throw new VaultError('conflict', 'This path already exists on disk. Choose a different name; nothing was overwritten.');
        }
        handle = await directory.getFileHandle(name, { create: true });
        // Keep a failed initial save retryable instead of treating our empty file as foreign.
        note.handle = handle; note.pendingCreation = true; note.savedContent = '';
      }
      if (!handle) throw new VaultError('missing', 'The original file is unavailable. Download your draft instead.');
      const unchanged = async () => {
        const current = await handle.getFile();
        if (await readText(current) !== note.savedContent) throw new VaultError('conflict', 'The file changed outside this tab. Download your draft, then reload the disk version to reconcile it.');
      };
      await unchanged();
      const writer = await handle.createWritable({ mode: 'exclusive' });
      try {
        await unchanged();
        await writer.write(content);
        await writer.close();
      } catch (error) { try { await writer.abort(); } catch { /* The writer may already be closed. */ } throw error; }
      // Do not turn a successful write into a failed save if a later stat fails.
      let modified = Date.now();
      try { modified = (await handle.getFile()).lastModified; } catch { /* Content was committed successfully. */ }
      return { handle, savedContent: content, modified, isNew: false, pendingCreation: false, diskChanged: false };
    };
    return globalThis.navigator?.locks ? navigator.locks.request(`ekphos:${this.name}:${note.path}`, save) : save();
  }
  async asset(target, from) { return readAsset(this.assets, target, from); }
}

export class ImportedVault {
  constructor(files) { this.files = [...files]; this.name = this.files[0]?.webkitRelativePath?.split('/')[0] || 'Imported folder'; this.mode = 'readonly'; this.assets = new Map(); }
  async read(onProgress = () => {}) {
    const notes = new Map(), warnings = [], assets = new Map();
    let bytes = 0, entries = 0;
    for (const file of this.files) {
      if (++entries > LIMITS.entries) { warnings.push('Entry limit reached; not every file was scanned.'); break; }
      const path = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
      const parts = path.split('/');
      if (parts.some(ignored)) continue;
      if (parts.length > LIMITS.depth + 1) { warnings.push(`${path}: folder depth limit reached.`); continue; }
      if (raster.test(path)) { assets.set(path, { file }); continue; }
      if (!isMarkdown(path)) continue;
      if (file.size > LIMITS.noteBytes) { warnings.push(`${path}: exceeds 1 MiB.`); continue; }
      if (notes.size >= LIMITS.notes || bytes + file.size > LIMITS.totalBytes) { warnings.push('Vault memory or note limit reached; not every note was loaded.'); break; }
      try { notes.set(path, await loadNote(path, file)); bytes += file.size; } catch (error) { warnings.push(`${path}: ${error.message}`); }
      if (notes.size % 25 === 0) { onProgress(notes.size); await new Promise((resolve) => setTimeout(resolve, 0)); }
    }
    this.assets = assets;
    return { notes, warnings };
  }
  async asset(target, from) { return readAsset(this.assets, target, from); }
}

export class DemoVault {
  constructor() { this.name = 'Example vault'; this.mode = 'demo'; }
  async read() { return { notes: new Map(Object.entries(DEMO_NOTES).map(([path, content]) => [path, { ...parseNote(path, content), savedContent: content, isNew: false, modified: 0 }])), warnings: [] }; }
  async asset() { return null; }
}

async function readAsset(assets, target, from) {
  const path = resolvePath(target, from);
  if (!path || !raster.test(path)) return null;
  const entry = assets.get(path);
  if (!entry) return null;
  const file = entry.handle ? await entry.handle.getFile() : entry.file;
  if (file.size > LIMITS.imageBytes) throw new VaultError('limit', 'Image exceeds 8 MiB.');
  return file;
}

/** A refresh updates clean notes but never discards drafts or their comparison baseline. */
export function reconcileRefresh(previous, fresh) {
  for (const [path, draft] of previous) {
    if (!isDirty(draft)) continue;
    const disk = fresh.get(path);
    draft.diskChanged = draft.isNew ? !!disk : !disk || disk.content !== draft.savedContent;
    if (disk && !draft.isNew) draft.handle = disk.handle;
    fresh.set(path, draft);
  }
  return fresh;
}
