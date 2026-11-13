import { ErrorCode, ShaderPlanError } from './errors.js';
import { expandLine } from './macro.js';
import { identifierAt, isIdentStart } from './textutils.js';

class Lexer {
  constructor(text, location) {
    this.text = text;
    this.index = 0;
    this.location = location;
  }

  skipSpaces() {
    while (this.index < this.text.length && /\s/.test(this.text[this.index])) {
      this.index += 1;
    }
  }

  peek() {
    this.skipSpaces();
    return this.text[this.index];
  }

  next() {
    this.skipSpaces();
    if (this.index >= this.text.length) return null;
    const char = this.text[this.index];
    if (isIdentStart(char)) {
      const word = identifierAt(this.text, this.index);
      this.index += word.length;
      return { type: 'ident', value: word };
    }
    if (/[0-9.]/.test(char)) {
      let end = this.index;
      while (end < this.text.length && /[0-9a-zA-Z._]/.test(this.text[end])) {
        end += 1;
      }
      const raw = this.text.slice(this.index, end);
      this.index = end;
      return { type: 'number', value: raw };
    }
    const two = this.text.slice(this.index, this.index + 2);
    if (['==', '!=', '>=', '<=', '&&', '||', '<<', '>>'].includes(two)) {
      this.index += 2;
      return { type: 'op', value: two };
    }
    this.index += 1;
    return { type: 'op', value: char };
  }
}

function parseNumber(raw, location) {
  const normalized = raw.replace(/[uUlL]+$/g, '');
  if (/^0[xX][0-9a-fA-F]+$/.test(normalized)) {
    return parseInt(normalized, 16);
  }
  if (/^0[0-7]+$/.test(normalized)) {
    return parseInt(normalized, 8);
  }
  const numeric = Number(normalized);
  if (Number.isNaN(numeric)) {
    throw new ShaderPlanError(
      ErrorCode.EXPRESSION_ERROR,
      `invalid numeric literal "${raw}" in preprocessor expression`,
      location
    );
  }
  return numeric;
}

class Parser {
  constructor(text, table, location) {
    const definedPattern = /defined\s*(?:\(\s*([A-Za-z_]\w*)\s*\)|([A-Za-z_]\w*))/g;
    const replaced = text.replace(definedPattern, (match, parenthesized, bare) => {
      const name = parenthesized || bare;
      return table.has(name) ? ' 1 ' : ' 0 ';
    });
    const expanded = expandLine(replaced, table, location);
    this.lexer = new Lexer(expanded, location);
    this.table = table;
    this.location = location;
    this.current = this.lexer.next();
  }

  consume(value) {
    if (!this.current || (value !== undefined && this.current.value !== value)) {
      throw new ShaderPlanError(
        ErrorCode.EXPRESSION_ERROR,
        `expected "${value}" but found "${this.current ? this.current.value : '<end>'}"`,
        this.location
      );
    }
    this.current = this.lexer.next();
  }

  parse() {
    const value = this.parseTernary();
    if (this.current) {
      throw new ShaderPlanError(
        ErrorCode.EXPRESSION_ERROR,
        `unexpected token "${this.current.value}" in preprocessor expression`,
        this.location
      );
    }
    return value !== 0;
  }

  parseTernary() {
    const condition = this.parseLogicalOr();
    if (this.current && this.current.value === '?') {
      this.consume('?');
      const whenTrue = this.parseTernary();
      this.consume(':');
      const whenFalse = this.parseTernary();
      return condition ? whenTrue : whenFalse;
    }
    return condition;
  }

  parseLogicalOr() {
    let value = this.parseLogicalAnd();
    while (this.current && this.current.value === '||') {
      this.consume('||');
      const right = this.parseLogicalAnd();
      value = value || right;
    }
    return value ? 1 : 0;
  }

  parseLogicalAnd() {
    let value = this.parseBitwiseOr();
    while (this.current && this.current.value === '&&') {
      this.consume('&&');
      const right = this.parseBitwiseOr();
      value = value && right;
    }
    return value ? 1 : 0;
  }

  parseBitwiseOr() {
    let value = this.parseBitwiseXor();
    while (this.current && this.current.value === '|') {
      this.consume('|');
      value |= this.parseBitwiseXor();
    }
    return value;
  }

  parseBitwiseXor() {
    let value = this.parseBitwiseAnd();
    while (this.current && this.current.value === '^') {
      this.consume('^');
      value ^= this.parseBitwiseAnd();
    }
    return value;
  }

  parseBitwiseAnd() {
    let value = this.parseEquality();
    while (this.current && this.current.value === '&') {
      this.consume('&');
      value &= this.parseEquality();
    }
    return value;
  }

  parseEquality() {
    let value = this.parseRelational();
    while (this.current && (this.current.value === '==' || this.current.value === '!=')) {
      const op = this.current.value;
      this.consume(op);
      const right = this.parseRelational();
      value = op === '==' ? value === right : value !== right;
      value = value ? 1 : 0;
    }
    return value;
  }

  parseRelational() {
    let value = this.parseShift();
    while (this.current && ['<', '>', '<=', '>='].includes(this.current.value)) {
      const op = this.current.value;
      this.consume(op);
      const right = this.parseShift();
      value = op === '<' ? value < right
        : op === '>' ? value > right
          : op === '<=' ? value <= right
            : value >= right;
      value = value ? 1 : 0;
    }
    return value;
  }

  parseShift() {
    let value = this.parseAdditive();
    while (this.current && (this.current.value === '<<' || this.current.value === '>>')) {
      const op = this.current.value;
      this.consume(op);
      const right = this.parseAdditive();
      value = op === '<<' ? value << right : value >> right;
    }
    return value;
  }

  parseAdditive() {
    let value = this.parseMultiplicative();
    while (this.current && (this.current.value === '+' || this.current.value === '-')) {
      const op = this.current.value;
      this.consume(op);
      const right = this.parseMultiplicative();
      value = op === '+' ? value + right : value - right;
    }
    return value;
  }

  parseMultiplicative() {
    let value = this.parseUnary();
    while (this.current && ['*', '/', '%'].includes(this.current.value)) {
      const op = this.current.value;
      this.consume(op);
      const right = this.parseUnary();
      if ((op === '/' || op === '%') && right === 0) {
        throw new ShaderPlanError(
          ErrorCode.EXPRESSION_ERROR,
          `division by zero in preprocessor expression`,
          this.location
        );
      }
      value = op === '*' ? value * right : op === '/' ? value / right : value % right;
    }
    return value;
  }

  parseUnary() {
    if (!this.current) {
      throw new ShaderPlanError(
        ErrorCode.EXPRESSION_ERROR,
        'unexpected end of preprocessor expression',
        this.location
      );
    }
    if (this.current.value === '!') {
      this.consume('!');
      return this.parseUnary() ? 0 : 1;
    }
    if (this.current.value === '~') {
      this.consume('~');
      return ~this.parseUnary();
    }
    if (this.current.value === '-') {
      this.consume('-');
      return -this.parseUnary();
    }
    if (this.current.value === '+') {
      this.consume('+');
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const token = this.current;
    if (!token) {
      throw new ShaderPlanError(
        ErrorCode.EXPRESSION_ERROR,
        'unexpected end of preprocessor expression',
        this.location
      );
    }
    if (token.value === '(') {
      this.consume('(');
      const value = this.parseTernary();
      this.consume(')');
      return value;
    }
    if (token.type === 'number') {
      this.consume(token.value);
      return parseNumber(token.value, this.location);
    }
    if (token.type === 'ident') {
      this.consume(token.value);
      return 0;
    }
    throw new ShaderPlanError(
      ErrorCode.EXPRESSION_ERROR,
      `unexpected token "${token.value}" in preprocessor expression`,
      this.location
    );
  }
}

export function evaluateExpression(expression, table, location) {
  if (expression.trim() === '') {
    throw new ShaderPlanError(
      ErrorCode.EXPRESSION_ERROR,
      '#if requires an expression',
      location
    );
  }
  return new Parser(expression, table, location).parse();
}
