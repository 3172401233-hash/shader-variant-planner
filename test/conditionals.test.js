import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './helpers/fixture.js';
import { ErrorCode, ShaderPlanError, expandStage, preprocessFile } from '../src/index.js';

test('handles nested ifdef ifndef else branches from explicit macros', async () => {
  const fixture = await createFixture({
    'main.vert': `
#ifdef FEATURE_A
#ifndef FEATURE_B
#define LABEL "a-only"
#else
#define LABEL "a-and-b"
#endif
#else
#define LABEL "base"
#endif
const char* label = LABEL;
`
  });
  try {
    const aOnly = await expandStage('vertex', fixture.path('main.vert'), {
      macros: { FEATURE_A: true }
    });
    assert.match(aOnly.source, /a-only/);
    assert.doesNotMatch(aOnly.source, /#/);

    const both = await expandStage('vertex', fixture.path('main.vert'), {
      macros: { FEATURE_A: true, FEATURE_B: true }
    });
    assert.match(both.source, /a-and-b/);

    const base = await expandStage('vertex', fixture.path('main.vert'), {
      macros: { FEATURE_B: true }
    });
    assert.match(base.source, /base/);
  } finally {
    await fixture.dispose();
  }
});

test('evaluates #if expressions with defined, arithmetic and logical operators', async () => {
  const fixture = await createFixture({
    'main.vert': `
#if defined(X) && (LEVEL >= 2 || MODE == 7)
int selected = 1;
#else
int selected = 0;
#endif
#if !defined(X)
int fallback = 1;
#endif
`
  });
  try {
    const on = await preprocessFile(fixture.path('main.vert'), {
      macros: { X: 1, LEVEL: 3, MODE: 0 }
    });
    assert.match(on.source, /int selected = 1;/);
    assert.doesNotMatch(on.source, /fallback/);

    const off = await preprocessFile(fixture.path('main.vert'), {
      macros: { LEVEL: 1, MODE: 7 }
    });
    assert.match(off.source, /int selected = 0;/);
    assert.match(off.source, /int fallback = 1;/);
  } finally {
    await fixture.dispose();
  }
});

test('inactive branches do not pull in missing includes', async () => {
  const fixture = await createFixture({
    'exists.glsl': 'int exists = 1;',
    'main.vert': `
#ifdef USE_MISSING
#include "missing.glsl"
#else
#include "exists.glsl"
#endif
`
  });
  try {
    const result = await expandStage('vertex', fixture.path('main.vert'));
    assert.match(result.source, /int exists/);
    assert.equal(result.files.length, 2);
  } finally {
    await fixture.dispose();
  }
});

test('unclosed conditional reports opening file and line', async () => {
  const fixture = await createFixture({
    'main.vert': 'lineOne();\n#ifdef X\nint x = 1;\n'
  });
  try {
    await assert.rejects(
      expandStage('vertex', fixture.path('main.vert')),
      (error) => {
        assert.equal(error.code, ErrorCode.UNCLOSED_CONDITIONAL);
        assert.equal(error.line, 2);
        assert.match(error.file, /main\.vert/);
        return true;
      }
    );
  } finally {
    await fixture.dispose();
  }
});

test('illegal directive and orphan endif carry location', async () => {
  const fixture = await createFixture({
    'main.vert': 'a();\n#bogus thing\n#endif\n'
  });
  try {
    await assert.rejects(
      expandStage('vertex', fixture.path('main.vert'), {
        permittedDirectives: []
      }),
      (error) => {
        assert.ok(error instanceof ShaderPlanError);
        assert.equal(error.code, ErrorCode.ILLEGAL_DIRECTIVE);
        assert.equal(error.line, 2);
        return true;
      }
    );
  } finally {
    await fixture.dispose();
  }
});

test('permitted directives are passed through untouched', async () => {
  const fixture = await createFixture({
    'main.vert': '#version 450\n#extension GL_EXT_scalar_block_layout : enable\nvoid main() {}'
  });
  try {
    const result = await preprocessFile(fixture.path('main.vert'), {
      permittedDirectives: ['version', 'extension']
    });
    assert.match(result.source, /#version 450/);
    assert.match(result.source, /#extension/);
  } finally {
    await fixture.dispose();
  }
});

test('#undef removes a macro before subsequent expansion', async () => {
  const fixture = await createFixture({
    'main.vert': '#define X 1\nint a = X;\n#undef X\nint b = X;'
  });
  try {
    const result = await preprocessFile(fixture.path('main.vert'));
    assert.match(result.source, /int a = 1;/);
    assert.match(result.source, /int b = X;/);
    assert.deepEqual(result.usedMacroKeys, ['X']);
  } finally {
    await fixture.dispose();
  }
});

test('accepts whitespace between hash and directive name', async () => {
  const fixture = await createFixture({
    'main.vert': '#  define DOUBLE(x) ((x) * 2)\nint v = DOUBLE(3);\n#  ifdef DOUBLE\nint ok = 1;\n#  endif'
  });
  try {
    const result = await preprocessFile(fixture.path('main.vert'));
    assert.match(result.source, /int v = \(\(3\) \* 2\);/);
    assert.match(result.source, /int ok = 1;/);
  } finally {
    await fixture.dispose();
  }
});
