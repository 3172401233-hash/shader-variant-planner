import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createFixture, crlf } from './helpers/fixture.js';
import {
  VariantPlanner,
  buildProgram,
  expandStage,
  normalizePath
} from '../src/index.js';

const TREE = {
  'shaders/used.glsl': 'float usedFeature() { return 1.0; }',
  'shaders/unused-a.glsl': 'float unusedA() { return 2.0; }',
  'shaders/unused-b.glsl': 'float unusedB() { return 3.0; }',
  'shaders/main.vert': `
#ifdef ENABLE_A
#include "unused-a.glsl"
#else
#include "unused-b.glsl"
#endif
#include "used.glsl"
void main() { float x = usedFeature(); }
`
};

test('only active-branch includes become dependencies', async () => {
  const fixture = await createFixture(TREE);
  try {
    const result = await expandStage('vertex', fixture.path('shaders/main.vert'), {
      macros: {}
    });
    assert.ok(result.files.some((file) => file.endsWith('unused-b.glsl')));
    assert.ok(!result.files.some((file) => file.endsWith('unused-a.glsl')));
    assert.ok(result.files.some((file) => file.endsWith('used.glsl')));
  } finally {
    await fixture.dispose();
  }
});

test('changing an unused include does not invalidate the variant', async () => {
  const fixture = await createFixture(TREE);
  try {
    const stage = await expandStage('vertex', fixture.path('shaders/main.vert'), { root: fixture.root });
    const planner = await VariantPlanner.create([stage], { root: fixture.root });
    const changedUnused = fixture.path('shaders/unused-a.glsl');
    await writeFile(changedUnused, 'float unusedA() { return 999.0; }');

    assert.deepEqual(planner.invalidate([changedUnused]), []);
    const touch = await planner.touch([changedUnused], async (file) => {
      const { readFile } = await import('node:fs/promises');
      return readFile(file, 'utf8');
    });
    assert.deepEqual(touch.reloaded, []);
    assert.deepEqual(touch.unchanged, []);

    const changedUsed = fixture.path('shaders/used.glsl');
    await writeFile(changedUsed, 'float usedFeature() { return 42.0; }');
    const ids = planner.invalidate([changedUsed]);
    assert.equal(ids.length, 1);
  } finally {
    await fixture.dispose();
  }
});

test('touch separates hash-identical line-ending changes from real content changes', async () => {
  const fixture = await createFixture(TREE);
  try {
    const stage = await expandStage('vertex', fixture.path('shaders/main.vert'), { root: fixture.root });
    const planner = await VariantPlanner.create([stage], { root: fixture.root });
    const usedFile = fixture.path('shaders/used.glsl');
    const { readFile } = await import('node:fs/promises');

    await writeFile(usedFile, crlf(TREE['shaders/used.glsl']));
    const lineEndingTouch = await planner.touch([usedFile], (file) => readFile(file, 'utf8'));
    assert.deepEqual(lineEndingTouch.reloaded, []);
    assert.deepEqual(lineEndingTouch.unchanged.length, 1);

    await writeFile(usedFile, 'float usedFeature() { return 7.0; }');
    const contentTouch = await planner.touch([usedFile], (file) => readFile(file, 'utf8'));
    assert.equal(contentTouch.reloaded.length, 1);
  } finally {
    await fixture.dispose();
  }
});

test('rebuild marks changed and unchanged program hashes', async () => {
  const fixture = await createFixture({
    'main.vert': 'void main() {}',
    'main.frag': 'void main() {}'
  });
  try {
    const build = () => buildProgram('simple', [
      { stage: 'vertex', file: fixture.path('main.vert') },
      { stage: 'fragment', file: fixture.path('main.frag') }
    ]);
    const initial = await build();
    const planner = new VariantPlanner();
    const id = planner.add(initial);

    const same = await planner.rebuild(id, [
      { stage: 'vertex', file: fixture.path('main.vert') },
      { stage: 'fragment', file: fixture.path('main.frag') }
    ]);
    assert.equal(same.changed, false);

    await writeFile(fixture.path('main.frag'), 'void main() { float changed = 1.0; }');
    const changed = await planner.rebuild(id, [
      { stage: 'vertex', file: fixture.path('main.vert') },
      { stage: 'fragment', file: fixture.path('main.frag') }
    ]);
    assert.equal(changed.changed, true);
    assert.notEqual(changed.previousHash, changed.nextHash);
  } finally {
    await fixture.dispose();
  }
});

test('repeated runs and path separator differences are deterministic', async () => {
  const tree = {
    'include/nested.glsl': 'float nested() { return 1.0; }',
    'main.vert': '#include "include/nested.glsl"\nvoid main() {}\n'
  };
  const fixture = await createFixture(tree);
  try {
    const posixEntry = fixture.path('main.vert');
    const windowsEntry = posixEntry.replace(/\//g, '\\');
    const options = { root: fixture.root };
    const first = await expandStage('vertex', posixEntry, options);
    const second = await expandStage('vertex', posixEntry, options);
    const windowsRead = await expandStage('vertex', windowsEntry, options);

    assert.equal(first.variantHash, second.variantHash);
    assert.equal(first.variantHash, windowsRead.variantHash);
    assert.deepEqual(first.files, windowsRead.files);
    assert.equal(first.source, windowsRead.source);
    assert.ok(first.files.every((file) => normalizePath(file) === file));
  } finally {
    await fixture.dispose();
  }
});

test('different explicit macros produce different variant hashes', async () => {
  const fixture = await createFixture({
    'main.vert': '#ifdef X\nint x = X;\n#else\nint x = 0;\n#endif'
  });
  try {
    const off = await expandStage('vertex', fixture.path('main.vert'), { macros: {} });
    const on = await expandStage('vertex', fixture.path('main.vert'), { macros: { X: 11 } });
    assert.notEqual(off.variantHash, on.variantHash);
    assert.deepEqual(on.macroKeys, ['X']);
    assert.deepEqual(on.usedMacroKeys, ['X']);
  } finally {
    await fixture.dispose();
  }
});
