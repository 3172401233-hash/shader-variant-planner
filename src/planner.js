import { ErrorCode, ShaderPlanError } from './errors.js';
import { sha256, stableStringify } from './hash.js';
import { normalizePath, relativeTo } from './pathutils.js';
import { preprocessFile, Preprocessor } from './preprocessor.js';
import { detectSlotConflicts, reflectResources } from './reflection.js';

export const STAGES = Object.freeze(['vertex', 'fragment', 'compute']);

function normalizeMacros(macros) {
  const result = {};
  for (const key of Object.keys(macros || {}).sort()) {
    const value = macros[key];
    if (value === undefined || value === null || value === false) continue;
    result[key] = value === true ? '1' : String(value);
  }
  return result;
}

export async function expandStage(stage, entryFile, options = {}) {
  if (!STAGES.includes(stage)) {
    throw new ShaderPlanError(
      ErrorCode.BAD_STAGE,
      `unknown stage "${stage}"; expected one of ${STAGES.join(', ')}`
    );
  }
  const macros = normalizeMacros(options.macros);
  const result = await preprocessFile(entryFile, {
    ...options,
    macros
  });
  const resources = reflectResources(result.source, stage, normalizePath(entryFile));
  detectSlotConflicts(resources);
  const files = [...result.files].sort();
  const fileHashes = {};
  for (const file of files) {
    fileHashes[file] = result.fileHashes[file];
  }
  return {
    stage,
    entryFile: result.entryFile,
    source: result.source,
    files,
    fileHashes,
    macros,
    macroKeys: Object.keys(macros).sort(),
    usedMacroKeys: result.usedMacroKeys,
    resources,
    origins: result.origins,
    variantHash: computeStageHash(stage, macros, fileHashes, result.source, resources)
  };
}

export function computeStageHash(stage, macros, fileHashes, source, resources) {
  const payload = {
    stage,
    macros,
    files: Object.keys(fileHashes).sort().map((file) => ({ file, hash: fileHashes[file] })),
    source: sha256(source),
    resources: resources.map((resource) => ({
      name: resource.name,
      kind: resource.kind,
      type: resource.type,
      set: resource.set,
      binding: resource.binding,
      stage: resource.stage
    }))
  };
  return sha256(stableStringify(payload));
}

export async function buildProgram(name, stageEntries, options = {}) {
  const stages = [];
  const resourceMap = new Map();
  const fileHashes = {};
  for (const entry of stageEntries) {
    const stage = await expandStage(entry.stage, entry.file, {
      ...options,
      macros: entry.macros ?? options.macros
    });
    stages.push(stage);
    for (const resource of stage.resources) {
      if (resource.binding === null) continue;
      const slotKey = `${resource.set}:${resource.binding}`;
      const existing = resourceMap.get(slotKey);
      if (existing && existing.name !== resource.name) {
        throw new ShaderPlanError(
          ErrorCode.SLOT_CONFLICT,
          `program "${name}" slot (set=${resource.set}, binding=${resource.binding}) is used by both "${existing.name}" and "${resource.name}"`,
          { file: resource.file, line: resource.line }
        );
      }
      if (!existing) resourceMap.set(slotKey, resource);
    }
    for (const file of stage.files) {
      if (fileHashes[file] && fileHashes[file] !== stage.fileHashes[file]) {
        throw new ShaderPlanError(
          ErrorCode.SLOT_CONFLICT,
          `file "${file}" has inconsistent normalized content between stages`
        );
      }
      fileHashes[file] = stage.fileHashes[file];
    }
  }
  const resources = stages.flatMap((stage) => stage.resources);
  const macros = mergeMacros(stages);
  const payload = {
    name,
    stages: stages.map((stage) => ({
      stage: stage.stage,
      hash: stage.variantHash,
      entryFile: stage.entryFile
    })),
    macros,
    files: Object.keys(fileHashes).sort().map((file) => ({ file, hash: fileHashes[file] })),
    resources: resources.map(({ name, kind, type, stage, set, binding }) => ({
      name, kind, type, stage, set, binding
    }))
  };
  return {
    name,
    stages,
    resources,
    macros,
    macroKeys: Object.keys(macros).sort(),
    files: Object.keys(fileHashes).sort(),
    fileHashes,
    programHash: sha256(stableStringify(payload))
  };
}

function mergeMacros(stages) {
  const merged = {};
  for (const stage of stages) {
    for (const key of Object.keys(stage.macros)) {
      if (merged[key] !== undefined && merged[key] !== stage.macros[key]) {
        merged[`${stage.stage}:${key}`] = stage.macros[key];
      } else {
        merged[key] = stage.macros[key];
      }
    }
  }
  return Object.fromEntries(Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)));
}

export class VariantPlanner {
  constructor(options = {}) {
    this.options = options;
    this.root = options.root ? normalizePath(options.root) : null;
    this.variants = new Map();
  }

  displayPath(file) {
    const normalized = normalizePath(file);
    return this.root ? relativeTo(this.root, normalized) : normalized;
  }

  add(variant) {
    const key = variant.id || variant.name || `${variant.stage}:${variant.variantHash}`;
    this.variants.set(key, {
      id: key,
      ...variant,
      files: [...variant.files].sort(),
      fileHashes: { ...variant.fileHashes },
      variantHash: variant.variantHash || variant.programHash
    });
    return key;
  }

  get(id) {
    return this.variants.get(id);
  }

  ids() {
    return [...this.variants.keys()].sort();
  }

  invalidate(changedFiles) {
    const changed = new Set(changedFiles.map((file) => this.displayPath(file)));
    const affected = [];
    for (const variant of this.variants.values()) {
      if (variant.files.some((file) => changed.has(file))) {
        affected.push(variant.id);
      }
    }
    return affected.sort();
  }

  async touch(changedFiles, reader) {
    const normalizedChanges = changedFiles.map((file) => this.displayPath(file));
    const candidates = this.invalidate(normalizedChanges);
    const reloaded = [];
    const stale = [];
    for (const id of candidates) {
      const variant = this.variants.get(id);
      let changedHash = false;
      for (const file of normalizedChanges) {
        if (!variant.fileHashes[file]) continue;
        const readPath = this.root ? normalizePath(`${this.root}/${file}`) : file;
        const nextContent = await reader(readPath);
        const nextHash = sha256(String(nextContent).replace(/\r\n?/g, '\n'));
        if (nextHash !== variant.fileHashes[file]) {
          changedHash = true;
          break;
        }
      }
      if (!changedHash) {
        stale.push(id);
        continue;
      }
      reloaded.push(id);
    }
    return { reloaded: reloaded.sort(), unchanged: stale.sort() };
  }

  async rebuild(id, stageEntries) {
    const previous = this.variants.get(id);
    if (!previous) {
      throw new ShaderPlanError(
        ErrorCode.UNKNOWN_VARIANT,
        `unknown variant id "${id}"`
      );
    }
    const program = await buildProgram(previous.name, stageEntries, this.options);
    const next = {
      id,
      ...program,
      files: program.files,
      variantHash: program.programHash
    };
    this.variants.set(id, next);
    return {
      id,
      changed: previous.variantHash !== next.variantHash,
      previousHash: previous.variantHash,
      nextHash: next.variantHash,
      program: next
    };
  }

  static async create(stagePlans, options = {}) {
    const planner = new VariantPlanner(options);
    for (const plan of stagePlans) {
      planner.add(plan);
    }
    return planner;
  }
}

export { Preprocessor };
