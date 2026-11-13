export function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

/**
 * Replace comment characters with spaces while preserving every newline so
 * that line numbers and column positions stay aligned with the source.
 */
export function stripComments(text) {
  const source = normalizeNewlines(text);
  const out = new Array(source.length);
  let state = 'normal';
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    const next = source[i + 1];
    if (state === 'normal') {
      if (char === '/' && next === '/') {
        state = 'line';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
      } else if (char === '/' && next === '*') {
        state = 'block';
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
      } else if (char === '"') {
        state = 'string';
        out[i] = char;
      } else {
        out[i] = char;
      }
    } else if (state === 'line') {
      if (char === '\n') {
        state = 'normal';
        out[i] = '\n';
      } else {
        out[i] = ' ';
      }
    } else if (state === 'block') {
      if (char === '*' && next === '/') {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 1;
        state = 'normal';
      } else if (char === '\n') {
        out[i] = '\n';
      } else {
        out[i] = ' ';
      }
    } else if (state === 'string') {
      out[i] = char;
      if (char === '\\' && i + 1 < source.length) {
        out[i + 1] = source[i + 1];
        i += 1;
      } else if (char === '"') {
        state = 'normal';
      }
    }
  }
  return out.join('');
}

const IDENTIFIER_START = /[A-Za-z_]/;
const IDENTIFIER_PART = /[A-Za-z0-9_]/;

export function isIdentStart(char) {
  return char !== undefined && IDENTIFIER_START.test(char);
}

export function isIdentPart(char) {
  return char !== undefined && IDENTIFIER_PART.test(char);
}

export function identifierAt(text, index) {
  if (!isIdentStart(text[index])) return null;
  let end = index;
  while (end < text.length && isIdentPart(text[end])) {
    end += 1;
  }
  return text.slice(index, end);
}
