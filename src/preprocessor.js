import { ErrorCode, ShaderPlanError } from './errors.js';
import { readFile as nodeReadFile } from 'node:fs/promises';
import { sha256 } from './hash.js';
import { expandLine, MacroTable, parseDefine } from './macro.js';
import { isAbsolutePath, normalizePath, relativeTo, resolveInclude } from './pathutils.js';
import { evaluateExpression } from './expression.js';
import { normalizeNewlines, stripComments } from './textutils.js';

const DIRECTIVE_RE = /^[ \t]*#[ \t]*([A-Za-z_]\w*)[ \t]?(.*)$/;

function defaultRead() {
  return async (path) => {
    try {
      return await nodeReadFile(path, 'utf8');
    } catch (error) {
      throw new ShaderPlanError(
        ErrorCode.INCLUDE_NOT_FOUND,
        `cannot read include "${path}": ${error.message}`,
        { file: normalizePath(path) }
      );
    }
  };
}

export class Preprocessor {
  constructor(options = {}) {
    this.readFile = options.readFile || null;
    this.roots = (options.roots || []).map(normalizePath);
    this.root = options.root ? normalizePath(options.root) : null;
    this.table = new MacroTable();
    this.files = [];
    this.fileHashes = new Map();
    this.fileSet = new Set();
    this.includeStack = [];
    this.outputLines = [];
    this.origins = [];
    this.permittedDirectives = new Set(options.permittedDirectives || []);
    this.seedMacros(options.macros || {});
  }

  seedMacros(macros) {
    for (const name of Object.keys(macros)) {
      const value = macros[name];
      if (value === undefined || value === null || value === false) continue;
      const body = value === true ? '1' : String(value);
      this.table.defineObject(name, body);
    }
  }

  async process(entryFile) {
    const entry = normalizePath(entryFile);
    await this.processFile(entry, null);
    const displayPath = (path) => (this.root ? relativeTo(this.root, path) : path);
    const files = this.files.map(displayPath);
    const fileHashes = {};
    for (const [path, hash] of this.fileHashes) {
      fileHashes[displayPath(path)] = hash;
    }
    return {
      source: this.outputLines.join('\n'),
      files,
      fileHashes,
      entryFile: displayPath(entry),
      macros: this.table.snapshot(),
      macroKeys: this.table.keys(),
      usedMacroKeys: [...this.table.used].sort(),
      origins: this.origins
    };
  }

  async read(path) {
    const reader = this.readFile || defaultRead();
    let content;
    try {
      content = await reader(path);
    } catch (error) {
      if (error instanceof ShaderPlanError) throw error;
      throw new ShaderPlanError(
        ErrorCode.INCLUDE_NOT_FOUND,
        `cannot read include "${path}": ${error.message}`,
        { file: path }
      );
    }
    if (typeof content !== 'string') {
      throw new ShaderPlanError(
        ErrorCode.INCLUDE_NOT_FOUND,
        `reader for "${path}" did not return string source`,
        { file: path }
      );
    }
    return normalizeNewlines(content);
  }

  async resolveAndRead(includePath, location) {
    const candidates = resolveInclude(includePath, location.file, this.roots);
    if (isAbsolutePath(includePath)) {
      const normalized = normalizePath(includePath);
      const content = await this.read(normalized);
      return { path: normalized, content };
    }
    let lastError;
    for (const candidate of candidates) {
      try {
        const content = await this.read(candidate);
        return { path: normalizePath(candidate), content };
      } catch (error) {
        if (error instanceof ShaderPlanError && error.code === ErrorCode.INCLUDE_NOT_FOUND) {
          lastError = error;
          continue;
        }
        throw error;
      }
    }
    throw new ShaderPlanError(
      ErrorCode.INCLUDE_NOT_FOUND,
      `include "${normalizePath(includePath)}" cannot be resolved from ${location.file}`,
      location
    );
  }

  registerFile(path, content) {
    const normalized = normalizePath(path);
    if (!this.fileSet.has(normalized)) {
      this.fileSet.add(normalized);
      this.files.push(normalized);
      this.fileHashes.set(normalized, sha256(content));
    }
  }

  async processFile(path) {
    const normalized = normalizePath(path);
    if (this.includeStack.includes(normalized)) {
      const chain = [...this.includeStack, normalized].join(' -> ');
      throw new ShaderPlanError(
        ErrorCode.INCLUDE_CYCLE,
        `cyclic include detected: ${chain}`,
        { file: normalized }
      );
    }
    const content = await this.read(normalized);
    this.registerFile(normalized, content);
    this.includeStack.push(normalized);
    try {
      await this.processContent(content, normalized);
    } finally {
      this.includeStack.pop();
    }
  }

  async processContent(content, file) {
    const clean = stripComments(content);
    const lines = clean.split('\n');
    const conditionStack = [];

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex];
      const location = { file, line: lineIndex + 1 };
      const directive = line.match(DIRECTIVE_RE);
      const active = conditionStack.every((frame) => frame.currentActive);

      if (!directive) {
        if (active) {
          const expanded = expandLine(line, this.table, location);
          this.outputLines.push(expanded);
          this.origins.push(location);
        }
        continue;
      }

      const [, name, restRaw] = directive;
      const rest = restRaw.trim();
      await this.handleDirective(name, rest, location, conditionStack, active, line);
    }

    if (conditionStack.length > 0) {
      const frame = conditionStack[conditionStack.length - 1];
      throw new ShaderPlanError(
        ErrorCode.UNCLOSED_CONDITIONAL,
        `conditional block opened by #${frame.opener} is missing #endif`,
        { file, line: frame.line }
      );
    }
  }

  async handleDirective(name, rest, location, stack, active, rawLine) {
    switch (name) {
      case 'if':
      case 'ifdef':
      case 'ifndef': {
        let taken = false;
        if (active) {
          taken = this.evaluateCondition(name, rest, location);
        }
        stack.push({
          opener: name,
          line: location.line,
          parentActive: active,
          currentActive: active && taken,
          anyTaken: active && taken,
          elseSeen: false
        });
        return;
      }
      case 'else': {
        if (rest !== '') {
          throw new ShaderPlanError(
            ErrorCode.ILLEGAL_DIRECTIVE,
            '#else does not take arguments',
            location
          );
        }
        if (stack.length === 0) {
          throw new ShaderPlanError(
            ErrorCode.ILLEGAL_DIRECTIVE,
            '#else without matching #if',
            location
          );
        }
        const frame = stack[stack.length - 1];
        if (frame.elseSeen) {
          throw new ShaderPlanError(
            ErrorCode.ILLEGAL_DIRECTIVE,
            'duplicate #else in conditional block',
            location
          );
        }
        frame.elseSeen = true;
        frame.currentActive = frame.parentActive && !frame.anyTaken;
        frame.anyTaken = frame.anyTaken || frame.currentActive;
        return;
      }
      case 'endif': {
        if (rest !== '') {
          throw new ShaderPlanError(
            ErrorCode.ILLEGAL_DIRECTIVE,
            '#endif does not take arguments',
            location
          );
        }
        if (stack.length === 0) {
          throw new ShaderPlanError(
            ErrorCode.ILLEGAL_DIRECTIVE,
            '#endif without matching #if',
            location
          );
        }
        stack.pop();
        return;
      }
      default: {
        if (!active) return;
        if (name === 'include') {
          await this.handleInclude(rest, location);
          return;
        }
        if (name === 'define') {
          const definition = parseDefine(rest, location);
          if (definition.functionLike) {
            this.table.defineFunction(definition.name, definition.params, definition.body, location);
          } else {
            this.table.defineObject(definition.name, definition.body, location);
          }
          return;
        }
        if (name === 'undef') {
          const macroName = rest.split(/\s+/)[0];
          if (!macroName || !/^[A-Za-z_]\w*$/.test(macroName)) {
            throw new ShaderPlanError(
              ErrorCode.ILLEGAL_DIRECTIVE,
              `malformed #undef directive: "${rest}"`,
              location
            );
          }
          this.table.undef(macroName);
          return;
        }
        if (this.permittedDirectives.has(name)) {
          this.outputLines.push(rawLine);
          this.origins.push(location);
          return;
        }
        throw new ShaderPlanError(
          ErrorCode.ILLEGAL_DIRECTIVE,
          `unsupported preprocessor directive "#${name}"`,
          location
        );
      }
    }
  }

  evaluateCondition(name, rest, location) {
    if (name === 'ifdef') {
      const macroName = rest.split(/\s+/)[0];
      if (!macroName || !/^[A-Za-z_]\w*$/.test(macroName)) {
        throw new ShaderPlanError(
          ErrorCode.ILLEGAL_DIRECTIVE,
          `malformed #ifdef directive: "${rest}"`,
          location
        );
      }
      return this.table.has(macroName);
    }
    if (name === 'ifndef') {
      const macroName = rest.split(/\s+/)[0];
      if (!macroName || !/^[A-Za-z_]\w*$/.test(macroName)) {
        throw new ShaderPlanError(
          ErrorCode.ILLEGAL_DIRECTIVE,
          `malformed #ifndef directive: "${rest}"`,
          location
        );
      }
      return !this.table.has(macroName);
    }
    return evaluateExpression(rest, this.table, location);
  }

  async handleInclude(rest, location) {
    const quoted = rest.match(/^"([^"]+)"$/);
    const angled = rest.match(/^<([^>]+)>$/);
    const match = quoted || angled;
    if (!match) {
      throw new ShaderPlanError(
        ErrorCode.ILLEGAL_DIRECTIVE,
        `malformed #include directive: "${rest}"`,
        location
      );
    }
    const includePath = normalizePath(match[1]);
    const resolved = await this.resolveAndRead(includePath, location);
        await this.processFile(resolved.path);
  }
}

export async function preprocessFile(entryFile, options = {}) {
  const processor = new Preprocessor(options);
  return processor.process(entryFile);
}
