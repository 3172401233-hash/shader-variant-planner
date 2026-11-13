import { ErrorCode, ShaderPlanError } from './errors.js';
import { identifierAt, isIdentPart, isIdentStart } from './textutils.js';

export const TOKEN = Object.freeze({
  IDENT: 'ident',
  NUMBER: 'number',
  PUNCT: 'punct',
  STRING: 'string'
});

const PUNCTUATORS = ['##', '...', '==', '!=', '>=', '<=', '&&', '||', '<<', '>>'];

export function tokenize(text, location = null) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const char = text[i];
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      let end = i;
      while (end < text.length && /[ \t\n\r]/.test(text[end])) end += 1;
      const whitespace = text.slice(i, end).replace(/[\n\r]+/g, ' ');
      if (tokens.length > 0) {
        tokens[tokens.length - 1].after = (tokens[tokens.length - 1].after || '') + whitespace;
      }
      i = end;
      continue;
    }
    if (isIdentStart(char)) {
      const word = identifierAt(text, i);
      tokens.push({ type: TOKEN.IDENT, value: word, after: '' });
      i += word.length;
      continue;
    }
    if (char === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') {
        if (text[end] === '\\') end += 1;
        end += 1;
      }
      if (end >= text.length) {
        throw new ShaderPlanError(
          ErrorCode.ILLEGAL_DIRECTIVE,
          'unterminated string literal in macro',
          location
        );
      }
      tokens.push({ type: TOKEN.STRING, value: text.slice(i, end + 1), after: '' });
      i = end + 1;
      continue;
    }
    if (/[0-9.]/.test(char) || (char === '.' && /[0-9]/.test(text[i + 1] || ''))) {
      let end = i + 1;
      while (end < text.length && /[0-9a-zA-Z._]/.test(text[end])) {
        end += 1;
      }
      tokens.push({ type: TOKEN.NUMBER, value: text.slice(i, end), after: '' });
      i = end;
      continue;
    }
    const multi = PUNCTUATORS.find((p) => text.startsWith(p, i));
    if (multi) {
      tokens.push({ type: TOKEN.PUNCT, value: multi, after: '' });
      i += multi.length;
      continue;
    }
    tokens.push({ type: TOKEN.PUNCT, value: char, after: '' });
    i += 1;
  }
  return tokens;
}

export function stringifyTokens(tokens) {
  let out = '';
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (out) {
      const prev = tokens[index - 1];
      if (token.before) {
        out += token.before;
      } else if (prev && prev.after !== '') {
        out += prev.after;
      } else if (needsSpaceBetween(lastValue(out), token.value)) {
        out += ' ';
      }
    }
    out += token.value;
  }
  return out;
}

function lastValue(text) {
  return text[text.length - 1] || '';
}

function needsSpaceBetween(left, right) {
  if (!left || !right) return false;
  if (isIdentPart(left) && isIdentPart(right)) return true;
  if (left === '+' && right === '+') return true;
  if (left === '-' && right === '-') return true;
  if (left === '&' && right === '&') return true;
  if (left === '|' && right === '|') return true;
  if (left === '=' && right === '=') return true;
  if (left === '!' && right === '=') return true;
  if (left === '<' && (right === '<' || right === '=')) return true;
  if (left === '>' && (right === '>' || right === '=')) return true;
  if (left === '.' || right === '(' || right === '[') return false;
  return false;
}

export class MacroTable {
  constructor() {
    this.definitions = new Map();
    this.used = new Set();
  }

 defineObject(name, body, location = null) {
    this.definitions.set(name, {
      functionLike: false,
      params: [],
      body: tokenize(body, location),
      location
    });
  }

  defineFunction(name, params, body, location = null) {
    const seen = new Set();
    for (const param of params) {
      if (seen.has(param)) {
        throw new ShaderPlanError(
          ErrorCode.DUPLICATE_PARAMETER,
          `function-like macro "${name}" declares duplicate parameter "${param}"`,
          location
        );
      }
      seen.add(param);
    }
    this.definitions.set(name, {
      functionLike: true,
      params,
      body: tokenize(body, location),
      location
    });
  }

  undef(name) {
    this.definitions.delete(name);
  }

  get(name) {
    return this.definitions.get(name);
  }

  has(name) {
    return this.definitions.has(name);
  }

  markUsed(name) {
    if (this.definitions.has(name)) this.used.add(name);
  }

  snapshot() {
    const result = {};
    for (const name of [...this.definitions.keys()].sort()) {
      const macro = this.definitions.get(name);
      result[name] = stringifyTokens(macro.body);
    }
    return result;
  }

  keys() {
    return [...this.definitions.keys()].sort();
  }
}

export function expandLine(text, table, location = null, hidden = new Set()) {
  return stringifyTokens(expandTokens(tokenize(text, location), table, location, hidden));
}

function expandTokens(tokens, table, location, hidden) {
  const output = [];
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    const macro = token.type === TOKEN.IDENT ? table.get(token.value) : null;
    if (!macro || hidden.has(token.value)) {
      output.push({ ...token });
      index += 1;
      continue;
    }

    if (!macro.functionLike) {
      table.markUsed(token.value);
      const nextHidden = new Set(hidden);
      nextHidden.add(token.value);
      const expanded = expandTokens(macro.body, table, location, nextHidden);
      if (expanded.length > 0) {
        const first = { ...expanded[0] };
        output.push(first);
        for (let inner = 1; inner < expanded.length; inner += 1) {
          output.push({ ...expanded[inner] });
        }
        output[output.length - 1].after = token.after || output[output.length - 1].after || '';
      }
      index += 1;
      continue;
    }

    const nextToken = tokens[index + 1];
    if (!nextToken || nextToken.type !== TOKEN.PUNCT || nextToken.value !== '(' || token.after) {
      output.push({ ...token });
      index += 1;
      continue;
    }

    const call = parseCallTokens(tokens, index, location);
    if (call.argTokens.length !== macro.params.length) {
      throw new ShaderPlanError(
        ErrorCode.MACRO_ARG_COUNT,
        `macro "${token.value}" expects ${macro.params.length} argument(s) but received ${call.argTokens.length}`,
        location
      );
    }
    table.markUsed(token.value);
    const expandedArgs = call.argTokens.map((argTokens) =>
      expandTokens(argTokens, table, location, hidden)
    );
    const substituted = substituteArgumentTokens(macro.body, macro.params, expandedArgs);
    const nextHidden = new Set(hidden);
    nextHidden.add(token.value);
    const expanded = expandTokens(substituted, table, location, nextHidden);
    for (const expandedToken of expanded) output.push({ ...expandedToken });
    if (expanded.length > 0) {
      output[output.length - 1].after = call.trailingWhitespace;
    }
    index = call.nextIndex;
  }
  return output;
}

function parseCallTokens(tokens, start, location) {
  const argTokens = [];
  let current = [];
  let depth = 0;
  let index = start + 2;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === TOKEN.PUNCT && token.value === '(') {
      depth += 1;
      current.push({ ...token });
      continue;
    }
    if (token.type === TOKEN.PUNCT && token.value === ')') {
      if (depth === 0) {
        if (!(current.length === 0 && argTokens.length === 0)) argTokens.push(current);
        const trailingWhitespace = token.after || '';
        return { argTokens, nextIndex: index + 1, trailingWhitespace };
      }
      depth -= 1;
      current.push({ ...token });
      continue;
    }
    if (depth === 0 && token.type === TOKEN.PUNCT && token.value === ',') {
      argTokens.push(current);
      current = [];
      continue;
    }
    current.push({ ...token });
  }
  throw new ShaderPlanError(
    ErrorCode.MACRO_ARG_COUNT,
    'missing closing parenthesis in function-like macro call',
    location
  );
}

function substituteArgumentTokens(bodyTokens, params, expandedArgs) {
  const values = new Map();
  params.forEach((param, index) => values.set(param, expandedArgs[index] || []));
  return bodyTokens.flatMap((token) => {
    if (token.type === TOKEN.IDENT && values.has(token.value)) {
      const replacement = values.get(token.value).map((argToken) => ({ ...argToken }));
      if (replacement.length > 0 && token.after) {
        replacement[replacement.length - 1].after = token.after;
      }
      return replacement;
    }
    return [{ ...token }];
  });
}

export function parseDefine(rest, location) {
  const trimmed = rest.trimStart();
  const name = identifierAt(trimmed, 0);
  if (!name) {
    throw new ShaderPlanError(
      ErrorCode.ILLEGAL_DIRECTIVE,
      `malformed #define directive: "${rest}"`,
      location
    );
  }
  const afterName = trimmed.slice(name.length);
  if (afterName.startsWith('(')) {
    const close = afterName.indexOf(')');
    if (close === -1) {
      throw new ShaderPlanError(
        ErrorCode.ILLEGAL_DIRECTIVE,
        `malformed function-like macro "${name}"`,
        location
      );
    }
    const inner = afterName.slice(1, close).trim();
    const params = inner === '' ? [] : inner.split(',').map((p) => p.trim());
    const body = afterName.slice(close + 1).trim();
    return { name, functionLike: true, params, body };
  }
  return { name, functionLike: false, params: [], body: afterName.trim() };
}
