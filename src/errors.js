export const ErrorCode = Object.freeze({
  INCLUDE_NOT_FOUND: 'INCLUDE_NOT_FOUND',
  INCLUDE_CYCLE: 'INCLUDE_CYCLE',
  DUPLICATE_PARAMETER: 'DUPLICATE_PARAMETER',
  UNCLOSED_CONDITIONAL: 'UNCLOSED_CONDITIONAL',
  ILLEGAL_DIRECTIVE: 'ILLEGAL_DIRECTIVE',
  MACRO_ARG_COUNT: 'MACRO_ARG_COUNT',
  EXPRESSION_ERROR: 'EXPRESSION_ERROR',
  SLOT_CONFLICT: 'SLOT_CONFLICT',
  BAD_STAGE: 'BAD_STAGE',
  UNKNOWN_VARIANT: 'UNKNOWN_VARIANT'
});

export class ShaderPlanError extends Error {
  constructor(code, message, location = null) {
    const where = location
      ? `${location.file}${location.line ? `:${location.line}` : ''}: `
      : '';
    super(`${where}${message} [${code}]`);
    this.name = 'ShaderPlanError';
    this.code = code;
    this.file = location ? location.file : null;
    this.line = location ? location.line : null;
  }
}
