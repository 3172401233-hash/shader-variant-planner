import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizePath } from '../../src/pathutils.js';

export async function createFixture(tree) {
  const root = await mkdtemp(join(tmpdir(), 'shader-variant-'));
  for (const [relativePath, content] of Object.entries(tree)) {
    const fullPath = join(root, relativePath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
  }
  return {
    root: normalizePath(root),
    path(relativePath) {
      return normalizePath(join(root, relativePath));
    },
    winPath(relativePath) {
      return normalizePath(join(root, relativePath)).replace(/\//g, '\\');
    },
    async dispose() {
      await rm(root, { recursive: true, force: true });
    }
  };
}

export function makeReader(tree) {
  const normalized = new Map();
  for (const [path, content] of Object.entries(tree)) {
    normalized.set(normalizePath(path), content);
  }
  return async (path) => {
    const key = normalizePath(path);
    if (!normalized.has(key)) {
      const error = new Error(`ENOENT: missing ${key}`);
      error.code = 'ENOENT';
      throw error;
    }
    return normalized.get(key);
  };
}

export function crlf(text) {
  return text.replace(/\n/g, '\r\n');
}
