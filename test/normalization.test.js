import test from 'node:test';
import assert from 'node:assert/strict';
import { makeReader } from './helpers/fixture.js';
import {
  ErrorCode,
  ShaderPlanError,
  normalizeNewlines,
  normalizePath,
  preprocessFile,
  sha256,
  stripComments
} from '../src/index.js';

test('path normalization handles drives, backslashes and repeated separators', () => {
  assert.equal(normalizePath('C:\\assets\\shaders\\../main.vert'), '/assets/main.vert');
  assert.equal(normalizePath('//assets//shaders//main.vert'), '/assets/shaders/main.vert');
  assert.equal(normalizePath('assets\\shaders\\main.vert'), 'assets/shaders/main.vert');
  assert.equal(normalizePath(new URL('file:///C:/assets/main.vert')), '/assets/main.vert');
});

test('newline normalization and hashing collapse LF, CR and CRLF', () => {
  const lf = 'a\nb\nc';
  assert.equal(normalizeNewlines('a\r\nb\rc'), lf);
  assert.equal(sha256(normalizeNewlines('a\r\nb\r\nc')), sha256(lf));
});

test('comment stripping preserves line numbers and string literals', () => {
  const source = 'lineOne(); // tail\n/* multi\nline */\nconst char* x = "// not a comment";';
  const stripped = stripComments(source);
  assert.equal(stripped.split('\n').length, 4);
  assert.match(stripped, /lineOne/);
  assert.doesNotMatch(stripped, /tail/);
  assert.match(stripped, /"\/\/ not a comment"/);
});

test('custom reader supports virtual files and root-relative dependencies', async () => {
  const tree = {
    '/project/inc/nested.glsl': 'int nested = 1;',
    '/project/main.vert': '#include "inc/nested.glsl"\nvoid main() {}'
  };
  const result = await preprocessFile('/project/main.vert', {
    readFile: makeReader(tree),
    root: '/project'
  });
  assert.deepEqual(result.files, ['main.vert', 'inc/nested.glsl']);
  assert.match(result.source, /int nested/);
});

test('zero-argument and empty-body function macros expand safely', async () => {
  const tree = {
    '/main.vert': '#define VERSION() 450\n#define NOTHING()\nint v = VERSION();\nNOTHING()\n'
  };
  const result = await preprocessFile('/main.vert', { readFile: makeReader(tree) });
  assert.match(result.source, /int v = 450;/);
  assert.doesNotMatch(result.source, /NOTHING/);
});

test('expression errors carry source location', async () => {
  const tree = {
    '/main.vert': 'int a = 1;\n#if 1 / 0\nint bad = 1;\n#endif'
  };
  await assert.rejects(
    preprocessFile('/main.vert', { readFile: makeReader(tree) }),
    (error) => {
      assert.ok(error instanceof ShaderPlanError);
      assert.equal(error.code, ErrorCode.EXPRESSION_ERROR);
      assert.equal(error.line, 2);
      assert.equal(error.file, '/main.vert');
      return true;
    }
  );
});

test('malformed include directive reports line number', async () => {
  const tree = {
    '/main.vert': '#include broken.include'
  };
  await assert.rejects(
    preprocessFile('/main.vert', { readFile: makeReader(tree) }),
    (error) => error.code === ErrorCode.ILLEGAL_DIRECTIVE && error.line === 1
  );
});
