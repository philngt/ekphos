/** Minimal File System Access API test doubles. No production hooks are needed. */
export class MemoryFile {
  constructor(name, content = '') { this.name = name; this.kind = 'file'; this.content = content; this.modified = 1; this.locked = false; }
  async getFile() { if (this.deleted) throw new DOMException('File no longer exists.', 'NotFoundError'); return new File([this.content], this.name, { lastModified: this.modified }); }
  async createWritable(options) {
    this.lastOptions = options;
    if (this.locked) throw new DOMException('Another writer holds the file.', 'NoModificationAllowedError');
    this.locked = true; await this.onOpen?.(); let pending = '';
    return {
      write: async (value) => { if (this.failWrite) throw new Error('Injected write failure'); await this.onWrite?.(); pending = value; },
      close: async () => { if (this.failClose) throw new Error('Injected close failure'); this.content = pending; this.modified++; this.locked = false; },
      abort: async () => { this.locked = false; },
    };
  }
}
export class MemoryDirectory {
  constructor(name = 'Test vault') { this.name = name; this.kind = 'directory'; this.entries = new Map(); this.permission = 'granted'; }
  async *values() { yield* this.entries.values(); }
  async queryPermission() { return this.permission; }
  async requestPermission() { return this.permission; }
  async getDirectoryHandle(name, { create = false } = {}) {
    if (!this.entries.has(name)) { if (!create) throw new DOMException('Directory not found', 'NotFoundError'); this.entries.set(name, new MemoryDirectory(name)); }
    const entry = this.entries.get(name); if (entry.kind !== 'directory') throw new DOMException('Not a directory', 'TypeMismatchError'); return entry;
  }
  async getFileHandle(name, { create = false } = {}) {
    if (!this.entries.has(name)) { if (!create) throw new DOMException('File not found', 'NotFoundError'); this.entries.set(name, new MemoryFile(name)); }
    const entry = this.entries.get(name); if (entry.kind !== 'file') throw new DOMException('Not a file', 'TypeMismatchError'); return entry;
  }
  add(path, content) { const parts = path.split('/'); let dir = this; for (const name of parts.slice(0, -1)) { if (!dir.entries.has(name)) dir.entries.set(name, new MemoryDirectory(name)); dir = dir.entries.get(name); } const file = new MemoryFile(parts.at(-1), content); dir.entries.set(file.name, file); return file; }
  lookup(path) { return path.split('/').reduce((entry, part) => entry.entries.get(part), this); }
}
