import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './helpers/fixture.js';
import { ErrorCode, ShaderPlanError, buildProgram, expandStage } from '../src/index.js';

const VERTEX_SOURCE = `
layout(set = 0, binding = 0) uniform CameraBlock {
  mat4 viewProjection;
  vec3 eyePosition;
} camera;
layout(set = 1, binding = 2) uniform sampler2D shadowMap;
layout(set = 1, binding = 3) uniform texture2D colorTexture;
uniform vec4 plainColor;
void main() {}
`;

const FRAGMENT_SOURCE = `
layout(set = 0, binding = 1) buffer readonly ParticleBuffer {
  vec4 positions[];
} particles;
layout(set = 1, binding = 2) uniform sampler2D shadowMap;
void main() {}
`;

test('reflects uniform, buffer, texture and sampler metadata', async () => {
  const fixture = await createFixture({
    'main.vert': VERTEX_SOURCE
  });
  try {
    const result = await expandStage('vertex', fixture.path('main.vert'));
    const byName = Object.fromEntries(result.resources.map((r) => [r.name, r]));
    assert.equal(byName.camera.kind, 'buffer');
    assert.equal(byName.camera.set, 0);
    assert.equal(byName.camera.binding, 0);
    assert.deepEqual(byName.camera.members, ['viewProjection', 'eyePosition']);
    assert.equal(byName.shadowMap.kind, 'sampler');
    assert.equal(byName.colorTexture.kind, 'texture');
    assert.equal(byName.colorTexture.set, 1);
    assert.equal(byName.plainColor.kind, 'uniform');
    assert.equal(byName.plainColor.binding, null);
    assert.ok(result.resources.every((r) => r.stage === 'vertex'));
  } finally {
    await fixture.dispose();
  }
});

test('builds a program and keeps per-stage reflection data', async () => {
  const fixture = await createFixture({
    'main.vert': VERTEX_SOURCE,
    'main.frag': FRAGMENT_SOURCE
  });
  try {
    const program = await buildProgram('particles', [
      { stage: 'vertex', file: fixture.path('main.vert') },
      { stage: 'fragment', file: fixture.path('main.frag') }
    ]);
    const stages = new Set(program.resources.map((r) => r.stage));
    assert.deepEqual([...stages].sort(), ['fragment', 'vertex']);
    const fragmentBuffer = program.resources.find((r) => r.name === 'particles');
    assert.equal(fragmentBuffer.kind, 'buffer');
    assert.equal(fragmentBuffer.binding, 1);
    assert.match(program.programHash, /^[0-9a-f]{64}$/);
  } finally {
    await fixture.dispose();
  }
});

test('rejects different resources sharing the same set and binding', async () => {
  const fixture = await createFixture({
    'main.vert': `
layout(set = 2, binding = 5) uniform sampler2D firstTexture;
layout(set = 2, binding = 5) uniform sampler2D secondTexture;
void main() {}
`
  });
  try {
    await assert.rejects(
      expandStage('vertex', fixture.path('main.vert')),
      (error) => {
        assert.ok(error instanceof ShaderPlanError);
        assert.equal(error.code, ErrorCode.SLOT_CONFLICT);
        assert.match(error.message, /set=2, binding=5/);
        assert.match(error.message, /firstTexture/);
        assert.match(error.message, /secondTexture/);
        assert.equal(error.line, 3);
        return true;
      }
    );
  } finally {
    await fixture.dispose();
  }
});

test('allows the same resource name to reuse a slot across stages', async () => {
  const shared = 'layout(set = 0, binding = 4) uniform sampler2D sharedMap;\n';
  const fixture = await createFixture({
    'shared.glsl': shared,
    'main.vert': `#include "shared.glsl"\nvoid main() {}`,
    'main.frag': `#include "shared.glsl"\nvoid main() {}`
  });
  try {
    const program = await buildProgram('shared-slot', [
      { stage: 'vertex', file: fixture.path('main.vert') },
      { stage: 'fragment', file: fixture.path('main.frag') }
    ]);
    assert.equal(
      program.resources.filter((r) => r.name === 'sharedMap').length,
      2
    );
  } finally {
    await fixture.dispose();
  }
});

test('rejects unknown shader stages', async () => {
  const fixture = await createFixture({ 'main.glsl': 'void main() {}' });
  try {
    await assert.rejects(
      expandStage('geometry', fixture.path('main.glsl')),
      (error) => error.code === ErrorCode.BAD_STAGE
    );
  } finally {
    await fixture.dispose();
  }
});

test('reflects multi-line layouts and block instance arrays', async () => {
  const fixture = await createFixture({
    'main.vert': `
layout(
  set = 3,
  binding = 4
) uniform sampler2D multiLineSampler;
layout(set = 4, binding = 5) uniform InstanceBlock {
  vec4 value;
} instances[2];
`
  });
  try {
    const result = await expandStage('vertex', fixture.path('main.vert'));
    const sampler = result.resources.find((resource) => resource.name === 'multiLineSampler');
    const block = result.resources.find((resource) => resource.name === 'instances');
    assert.equal(sampler.set, 3);
    assert.equal(sampler.binding, 4);
    assert.equal(block.kind, 'buffer');
    assert.equal(block.binding, 5);
    assert.deepEqual(block.members, ['value']);
  } finally {
    await fixture.dispose();
  }
});

test('supports compute stage reflection and cross-stage slot conflicts', async () => {
  const fixture = await createFixture({
    'main.comp': 'layout(set = 0, binding = 0) buffer readonly DataBuffer { vec4 items[]; } data;',
    'other.vert': 'layout(set = 0, binding = 0) uniform sampler2D other;'
  });
  try {
    const compute = await expandStage('compute', fixture.path('main.comp'));
    assert.equal(compute.resources[0].stage, 'compute');
    assert.equal(compute.resources[0].kind, 'buffer');

    await assert.rejects(
      buildProgram('cross-stage', [
        { stage: 'compute', file: fixture.path('main.comp') },
        { stage: 'vertex', file: fixture.path('other.vert') }
      ]),
      (error) => {
        assert.equal(error.code, ErrorCode.SLOT_CONFLICT);
        assert.match(error.message, /data/);
        assert.match(error.message, /other/);
        return true;
      }
    );
  } finally {
    await fixture.dispose();
  }
});
