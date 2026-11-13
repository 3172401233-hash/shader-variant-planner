import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture, crlf } from './helpers/fixture.js';
import { ErrorCode, ShaderPlanError, expandStage, normalizePath } from '../src/index.js';

test('expands multi-level nested includes and records dependency order', async () => {
  const fixture = await createFixture({
    'shaders/common/constants.glsl': 'const float PI = 3.1415926;',
    'shaders/common/math.glsl': '#include "constants.glsl"\nfloat square(float x) { return x * x; }',
    'shaders/vertex/main.vert': '#include "../common/math.glsl"\nvoid main() { gl_Position = vec4(square(2.0)); }'
  });
  try {
    const result = await expandStage('vertex', fixture.path('shaders/vertex/main.vert'));
    assert.match(result.source, /const float PI/);
    assert.match(result.source, /float square/);
    assert.deepEqual(result.files, [
      normalizePath(fixture.path('shaders/common/constants.glsl')),
      normalizePath(fixture.path('shaders/common/math.glsl')),
      normalizePath(fixture.path('shaders/vertex/main.vert'))
    ]);
    assert.equal(result.files.length, new Set(result.files).size);
  } finally {
    await fixture.dispose();
  }
});

test('resolves includes from configured roots with angle brackets', async () => {
  const fixture = await createFixture({
    'include/lib/shared.glsl': 'vec3 sharedValue() { return vec3(1.0); }',
    'shaders/frag.frag': '#include <lib/shared.glsl>\nvoid main() {}'
  });
  try {
    const result = await expandStage('fragment', fixture.path('shaders/frag.frag'), {
      roots: [fixture.path('include')]
    });
    assert.ok(result.files.some((file) => file.endsWith('lib/shared.glsl')));
    assert.match(result.source, /sharedValue/);
  } finally {
    await fixture.dispose();
  }
});

test('normalizes Windows separators in both entry path and include path', async () => {
  const fixture = await createFixture({
    'shaders/a.glsl': 'float aValue = 1.0;',
    'shaders/main.vert': '#include "..\\shaders\\a.glsl"\nvoid main() {}'
  });
  try {
    const result = await expandStage('vertex', fixture.winPath('shaders/main.vert'));
    assert.ok(result.files.every((file) => !file.includes('\\')));
    assert.ok(result.entryFile.startsWith('/'));
    assert.match(result.source, /aValue/);
  } finally {
    await fixture.dispose();
  }
});

test('produces identical hashes for LF and CRLF copies', async () => {
  const lf = {
    'inc.glsl': 'float inc() { return 1.0; }',
    'main.vert': '#include "inc.glsl"\nvoid main() { float x = inc(); }'
  };
  const fixtureLf = await createFixture(lf);
  const fixtureCrlf = await createFixture({
    'inc.glsl': crlf(lf['inc.glsl']),
    'main.vert': crlf(lf['main.vert'])
  });
  try {
    const a = await expandStage('vertex', fixtureLf.path('main.vert'), { root: fixtureLf.root });
    const b = await expandStage('vertex', fixtureCrlf.path('main.vert'), { root: fixtureCrlf.root });
    assert.equal(a.source, b.source);
    assert.equal(a.variantHash, b.variantHash);
    assert.deepEqual(a.files, ['inc.glsl', 'main.vert']);
    assert.deepEqual(a.files, b.files);
    assert.deepEqual(
      Object.values(a.fileHashes).sort(),
      Object.values(b.fileHashes).sort()
    );
  } finally {
    await fixtureLf.dispose();
    await fixtureCrlf.dispose();
  }
});

test('reports missing include with file and line number', async () => {
  const fixture = await createFixture({
    'main.vert': 'void pre() {}\n#include "missing.glsl"\nvoid main() {}'
  });
  try {
    await assert.rejects(
      expandStage('vertex', fixture.path('main.vert')),
      (error) => {
        assert.ok(error instanceof ShaderPlanError);
        assert.equal(error.code, ErrorCode.INCLUDE_NOT_FOUND);
        assert.equal(error.line, 2);
        assert.match(error.file, /main\.vert$/);
        return true;
      }
    );
  } finally {
    await fixture.dispose();
  }
});

test('detects direct and transitive cyclic includes with chain', async () => {
  const fixture = await createFixture({
    'a.glsl': '#include "b.glsl"',
    'b.glsl': '#include "c.glsl"',
    'c.glsl': '#include "a.glsl"',
    'main.vert': '#include "a.glsl"\nvoid main() {}'
  });
  try {
    await assert.rejects(
      expandStage('vertex', fixture.path('main.vert')),
      (error) => {
        assert.equal(error.code, ErrorCode.INCLUDE_CYCLE);
        assert.match(error.message, /main\.vert.*a\.glsl.*b\.glsl.*c\.glsl.*a\.glsl/);
        assert.match(error.file, /a\.glsl$/);
        return true;
      }
    );
  } finally {
    await fixture.dispose();
  }
});

test('deduplicates the same included file while retaining its expansion each time', async () => {
  const fixture = await createFixture({
    'shared.glsl': 'float sharedValue = 1.0;',
    'a.glsl': '#include "shared.glsl"\nfloat aValue = sharedValue;',
    'b.glsl': '#include "shared.glsl"\nfloat bValue = sharedValue;',
    'main.vert': '#include "a.glsl"\n#include "b.glsl"\nvoid main() {}'
  });
  try {
    const result = await expandStage('vertex', fixture.path('main.vert'));
    assert.equal(result.files.filter((file) => file.endsWith('shared.glsl')).length, 1);
    assert.equal((result.source.match(/float sharedValue/g) || []).length, 2);
  } finally {
    await fixture.dispose();
  }
});
