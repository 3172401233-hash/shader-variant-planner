import { ErrorCode, ShaderPlanError } from './errors.js';
import { stripComments } from './textutils.js';

const LAYOUT_RE =
  /layout\s*\(([^)]*)\)\s*(?:in\s+|out\s+)?(uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?[A-Za-z_]\w*(?:\s*<[^;{}]*>)?|buffer|uniform)\b/g;
const BLOCK_RE =
  /layout\s*\(([^)]*)\)\s*([A-Za-z_][\w\s]*?)\b([A-Za-z_]\w*)\s*\{([^}]*)\}\s*([A-Za-z_]\w*)?(\s*\[[^\]]*\])?\s*;/g;
const PLAIN_UNIFORM_RE =
  /(^|[;{}])\s*uniform\s+(?:highp\s+|mediump\s+|lowp\s+)?([A-Za-z_]\w*(?:\s*<[^;{}]*>)?)\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*;/g;

const SAMPLER_TYPES = new Set([
  'sampler1D', 'sampler2D', 'sampler3D', 'samplerCube',
  'sampler2DArray', 'samplerCubeArray', 'sampler2DShadow',
  'sampler2DArrayShadow', 'samplerCubeShadow', 'samplerCubeArrayShadow',
  'sampler1DShadow', 'sampler2DMS', 'sampler2DMSArray',
  'isampler2D', 'usampler2D', 'isampler3D', 'usampler3D',
  'isamplerCube', 'usamplerCube'
]);

const TEXTURE_TYPES = new Set([
  'texture1D', 'texture2D', 'texture3D', 'textureCube',
  'texture2DArray', 'textureCubeArray', 'texture2DMS',
  'texture2DMSArray', 'itexture2D', 'utexture2D',
  'itexture3D', 'utexture3D'
]);

function parseLayout(qualifiers, location) {
  let set = 0;
  let binding = null;
  for (const part of qualifiers.split(',')) {
    const [key, valueRaw] = part.split('=').map((segment) => segment.trim());
    if (key === 'set') {
      const value = Number(valueRaw);
      if (!Number.isInteger(value)) {
        throw new ShaderPlanError(
          ErrorCode.ILLEGAL_DIRECTIVE,
          `invalid layout set value in "${qualifiers}"`,
          location
        );
      }
      set = value;
    }
    if (key === 'binding') {
      const value = Number(valueRaw);
      if (!Number.isInteger(value)) {
        throw new ShaderPlanError(
          ErrorCode.ILLEGAL_DIRECTIVE,
          `invalid layout binding value in "${qualifiers}"`,
          location
        );
      }
      binding = value;
    }
  }
  return { set, binding };
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function classifyType(typeName) {
  const base = typeName.replace(/\s+/g, '').replace(/<.*$/, '');
  if (SAMPLER_TYPES.has(base)) return 'sampler';
  if (TEXTURE_TYPES.has(base)) return 'texture';
  return 'uniform';
}

export function reflectResources(source, stage, file = '<expanded>') {
  const clean = stripComments(source);
  const resources = [];
  const blockSpans = [];

  let match;
  while ((match = BLOCK_RE.exec(clean)) !== null) {
    const [statement, qualifiers, qualifierText, blockName, body, instanceName] = match;
    const keyword = /\bbuffer\b/.test(qualifierText) ? 'buffer' : 'uniform';
    if (!/\b(?:uniform|buffer)\b/.test(qualifierText)) continue;
    blockSpans.push([match.index, match.index + statement.length]);
    const location = { file, line: lineAt(clean, match.index) };
    const { set, binding } = parseLayout(qualifiers, location);
    const members = body
      .split(';')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const memberMatch = line.match(/([A-Za-z_]\w*(?:\s*<[^>]*>)?)\s+([A-Za-z_]\w*)\s*(\[[^\]]*\])?/);
        return memberMatch ? memberMatch[2] : line;
      });
    resources.push({
      name: instanceName || blockName,
      blockName,
      kind: 'buffer',
      type: blockName,
      stage,
      set,
      binding,
      line: location.line,
      file,
      members
    });
  }

  const insideBlock = (index) =>
    blockSpans.some(([start, end]) => index >= start && index <= end);

  while ((match = LAYOUT_RE.exec(clean)) !== null) {
    if (insideBlock(match.index)) continue;
    const [statement, qualifiers, declaration] = match;
    if (clean[LAYOUT_RE.lastIndex] === '{' || /\{\s*$/.test(statement)) {
      continue;
    }
    const location = { file, line: lineAt(clean, match.index) };
    const { set, binding } = parseLayout(qualifiers, location);
    const tail = clean.slice(match.index + statement.length);
    const terminator = tail.search(/[;{}]/);
    const fullDeclaration = terminator === -1
      ? statement + tail
      : statement + tail.slice(0, terminator + 1);
    const nameMatch = fullDeclaration.match(/([A-Za-z_]\w*)\s*(\[[^\]]*\])?\s*;?\s*$/);
    const typeMatch = declaration.match(/(uniform|buffer)\s+(?:highp\s+|mediump\s+|lowp\s+)?([A-Za-z_]\w*(?:\s*<[^;{}]*>)?)/);
    if (!nameMatch || !typeMatch) continue;
    const name = nameMatch[1];
    const typeName = typeMatch[2];
    const kind = typeMatch[1] === 'buffer'
      ? 'buffer'
      : classifyType(typeName);
    resources.push({
      name,
      kind,
      type: typeName.replace(/\s+/g, ''),
      stage,
      set,
      binding,
      line: location.line,
      file,
      members: null
    });
  }

  PLAIN_UNIFORM_RE.lastIndex = 0;
  while ((match = PLAIN_UNIFORM_RE.exec(clean)) !== null) {
    if (insideBlock(match.index)) continue;
    const [, prefix, typeNameRaw, name] = match;
    const typeName = typeNameRaw.replace(/\s+/g, '');
    const location = { file, line: lineAt(clean, match.index + prefix.length) };
    resources.push({
      name,
      kind: classifyType(typeName),
      type: typeName,
      stage,
      set: 0,
      binding: null,
      line: location.line,
      file,
      members: null
    });
  }

  return dedupeResources(resources);
}

function dedupeResources(resources) {
  const seen = new Map();
  for (const resource of resources) {
    const key = `${resource.stage}:${resource.name}:${resource.line}`;
    if (!seen.has(key)) seen.set(key, resource);
  }
  return [...seen.values()].sort((a, b) => {
    if (a.set !== b.set) return a.set - b.set;
    if ((a.binding ?? -1) !== (b.binding ?? -1)) {
      return (a.binding ?? -1) - (b.binding ?? -1);
    }
    return a.name.localeCompare(b.name);
  });
}

export function detectSlotConflicts(resources) {
  const slots = new Map();
  for (const resource of resources) {
    if (resource.binding === null) continue;
    const key = `${resource.set}:${resource.binding}`;
    const previous = slots.get(key);
    if (!previous) {
      slots.set(key, resource);
      continue;
    }
    if (previous.name !== resource.name) {
      throw new ShaderPlanError(
        ErrorCode.SLOT_CONFLICT,
        `resource slot (set=${resource.set}, binding=${resource.binding}) is used by both "${previous.name}" and "${resource.name}"`,
        { file: resource.file, line: resource.line }
      );
    }
  }
}
