export {
  STAGES,
  VariantPlanner,
  buildProgram,
  computeStageHash,
  expandStage
} from './planner.js';
export { Preprocessor, preprocessFile } from './preprocessor.js';
export { MacroTable, expandLine, parseDefine, tokenize } from './macro.js';
export { evaluateExpression } from './expression.js';
export { detectSlotConflicts, reflectResources } from './reflection.js';
export { normalizePath, joinPath, posixStyle, resolveInclude, win32Style } from './pathutils.js';
export { normalizeNewlines, stripComments } from './textutils.js';
export { sha256, stableStringify } from './hash.js';
export { ErrorCode, ShaderPlanError } from './errors.js';
