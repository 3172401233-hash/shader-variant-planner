import test from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from './helpers/fixture.js';
import { ErrorCode, ShaderPlanError, expandLine, MacroTable, preprocessFile } from '../src/index.js';

test('expands object-like macros with nested substitution', async () => {
  const fixture = await createFixture({
    'main.vert': '#define A 1\n#define B A + 2\n#define C B * 3\nint value = C;'
  });
  try {
    const result = await preprocessFile(fixture.path('main.vert'));
    assert.match(result.source, /int value = 1 \+ 2 \* 3;/);
    assert.deepEqual(result.macroKeys, ['A', 'B', 'C']);
  } finally {
    await fixture.dispose();
  }
});

test('expands function-like macros and arguments before substitution', async () => {
  const table = new MacroTable();
  table.defineObject('X', '4');
  table.defineFunction('ADD', ['a', 'b'], 'a + b');
  table.defineFunction('SQUARE', ['x'], '((x) * (x))');
  assert.equal(expandLine('int v = ADD(X, SQUARE(3));', table), 'int v = 4 + ((3) * (3));');
});

test('prevents infinite self and mutual recursion', async () => {
  const table = new MacroTable();
  table.defineObject('A', 'B');
  table.defineObject('B', 'A');
  assert.equal(expandLine('A', table), 'A');

  const functionTable = new MacroTable();
  functionTable.defineFunction('LOOP', ['x'], 'LOOP(x) + x');
  assert.equal(expandLine('LOOP(7)', functionTable), 'LOOP(7) + 7');
});

test('reports duplicate function macro parameters with location', async () => {
  const fixture = await createFixture({
    'main.vert': '#define DUP(a, b, a) a + b\nint x = DUP(1, 2, 3);'
  });
  try {
    await assert.rejects(
      preprocessFile(fixture.path('main.vert')),
      (error) => {
        assert.ok(error instanceof ShaderPlanError);
        assert.equal(error.code, ErrorCode.DUPLICATE_PARAMETER);
        assert.equal(error.line, 1);
        assert.match(error.file, /main\.vert/);
        return true;
      }
    );
  } finally {
    await fixture.dispose();
  }
});

test('reports wrong function macro argument count with location', async () => {
  const fixture = await createFixture({
    'main.vert': '#define F(a, b) a - b\nint x = F(1);'
  });
  try {
    await assert.rejects(
      preprocessFile(fixture.path('main.vert')),
      (error) => {
        assert.equal(error.code, ErrorCode.MACRO_ARG_COUNT);
        assert.equal(error.line, 2);
        assert.match(error.message, /expects 2 argument\(s\) but received 1/);
        return true;
      }
    );
  } finally {
    await fixture.dispose();
  }
});

test('explicit macros participate and final keys are deterministic', async () => {
  const fixture = await createFixture({
    'main.vert': '#define LOCAL 9\n#ifdef EXTERNAL\nint e = EXTERNAL;\n#endif\nint l = LOCAL;'
  });
  try {
    const first = await preprocessFile(fixture.path('main.vert'), {
      macros: { ZETA: 2, EXTERNAL: 5, ALPHA: true }
    });
    const second = await preprocessFile(fixture.path('main.vert'), {
      macros: { ALPHA: true, ZETA: 2, EXTERNAL: 5 }
    });
    assert.deepEqual(first.macroKeys, ['ALPHA', 'EXTERNAL', 'LOCAL', 'ZETA']);
    assert.deepEqual(first.macroKeys, second.macroKeys);
    assert.deepEqual(first.usedMacroKeys, ['EXTERNAL', 'LOCAL']);
    assert.equal(first.macros.EXTERNAL, '5');
  } finally {
    await fixture.dispose();
  }
});

test('function-like macro name without immediate parenthesis stays an identifier', () => {
  const table = new MacroTable();
  table.defineFunction('F', ['x'], 'x');
  assert.equal(expandLine('F (1)', table), 'F (1)');
  assert.equal(expandLine('F(1)', table), '1');
});
