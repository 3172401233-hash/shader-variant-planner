import { isAbsolute, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const WINDOWS_DRIVE = /^([a-zA-Z]:)([\\/]|$)/;

export function normalizePath(value) {
  if (value instanceof URL) {
    value = fileURLToPath(value);
  }
  let text = String(value).replace(/\\/g, '/');
  const drive = text.match(WINDOWS_DRIVE);
  if (drive) {
    text = text.slice(drive[1].length);
  }
  const fileUrlDrive = text.match(/^\/([a-zA-Z]:)(\/|$)/);
  if (fileUrlDrive) {
    text = text.slice(3);
  }
  text = text.replace(/\/+/g, '/');
  const hasTrailingSlash = text.length > 1 && text.endsWith('/');
  const normalized = posix.normalize(text);
  if (hasTrailingSlash && !normalized.endsWith('/')) {
    return `${normalized}/`;
  }
  return normalized;
}

export function joinPath(base, part) {
  return normalizePath(posix.join(normalizePath(base), normalizePath(part)));
}

export function dirOf(filePath) {
  return posix.dirname(normalizePath(filePath));
}

export function relativeTo(root, filePath) {
  const normalizedRoot = normalizePath(root);
  const normalizedFile = normalizePath(filePath);
  if (normalizedFile === normalizedRoot) return '.';
  const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
  if (normalizedFile.startsWith(prefix)) {
    return normalizedFile.slice(prefix.length);
  }
  return normalizedFile;
}

export function isAbsolutePath(filePath) {
  const normalized = normalizePath(filePath);
  if (isAbsolute(normalized)) return true;
  if (WINDOWS_DRIVE.test(String(filePath))) return true;
  return false;
}

export function resolveInclude(includePath, includingFile, roots) {
  const target = normalizePath(includePath);
  if (isAbsolutePath(target)) {
    return target;
  }
  const baseDir = includingFile ? dirOf(includingFile) : normalizePath('.');
  const candidates = [posix.join(baseDir, target)];
  for (const root of roots || []) {
    candidates.push(posix.join(normalizePath(root), target));
  }
  return candidates;
}

export function win32Style(filePath) {
  return normalizePath(filePath).replace(/\//g, '\\');
}

export function posixStyle(filePath) {
  return normalizePath(filePath);
}

