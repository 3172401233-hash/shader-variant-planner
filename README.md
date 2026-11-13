# shader-variant-planner

零第三方依赖、不启动 GPU 驱动的 Node.js GLSL Shader 变体规划库。它在游戏引擎启动前展开 GLSL 源码，生成稳定的 variant hash，并在资源热更新时判断哪些 Shader Program 需要重新加载。

只使用 Node.js 内置模块（`node:fs/promises`、`node:crypto`、`node:path`、`node:test`），不包含渲染器、图形上下文或界面。

## 能力

- 预处理指令：`#include`、`#define`、`#undef`、`#if`、`#ifdef`、`#ifndef`、`#else`、`#endif`
- 多级 include、include root、引号与尖括号路径、循环引用检测
- Windows `/`、`\` 路径统一规范化为 POSIX 路径
- LF、CR、CRLF 统一规范化为 LF，因此换行差异不会改变 hash
- 对象式宏与简单函数式宏，参数先展开再代入，递归宏自动停止
- 条件分支中未使用的 include 不会进入依赖集合，也不会触发该 variant 失效
- 反射 `uniform`、`buffer`（UBO/SSBO block）、`texture`、`sampler` 的名称、stage、set、binding
- 检测同一 stage 以及同一 program 内不同资源的 `(set, binding)` 槽位冲突
- 使用 SHA-256 生成文件 hash、stage variant hash 和 program hash
- 所有对象键、文件列表和宏键均排序，重复运行结果确定

## 安装与测试

```bash
npm test
```

`npm test` 实际执行：

```bash
node --test
```

不需要 `npm install`，`package.json` 中没有 `dependencies` 或 `devDependencies`。

## 快速开始

```js
import { expandStage, VariantPlanner } from 'shader-variant-planner';

const vertex = await expandStage('vertex', '/project/shaders/main.vert', {
  root: '/project',
  roots: ['/project/include'],
  macros: {
    ENABLE_SHADOW: true,
    MAX_LIGHTS: 8
  }
});

console.log(vertex.files);
console.log(vertex.macroKeys);
console.log(vertex.usedMacroKeys);
console.log(vertex.resources);
console.log(vertex.variantHash);
```

`root` 用于把机器相关的绝对路径转换为稳定的项目相对路径；跨机器或跨临时目录比较 hash 时应传入相同项目根。未传 `root` 时保留规范化后的绝对路径。

## 构建 Program

```js
import { buildProgram } from 'shader-variant-planner';

const program = await buildProgram('character', [
  { stage: 'vertex', file: '/project/shaders/character.vert' },
  { stage: 'fragment', file: '/project/shaders/character.frag' }
], {
  root: '/project',
  macros: { SKINNING: 1 }
});
```

返回内容包含：

- `programHash`：整个 program 的稳定 hash
- `stages`：每个 stage 的展开结果和 `variantHash`
- `files` / `fileHashes`：实际参与当前分支的依赖文件
- `macros` / `macroKeys`：最终宏集合
- `resources`：跨 stage 反射结果

## 热更新失效

```js
import { VariantPlanner } from 'shader-variant-planner';

const planner = new VariantPlanner();
planner.add(vertex);

const candidates = planner.invalidate(['shaders/optional/unused.glsl']);
// candidates 为 []，因为当前宏分支没有依赖该文件

const result = await planner.touch(['shaders/common/camera.glsl'], async (file) => {
  return readFile(file, 'utf8');
});

// result.reloaded：依赖文件规范化内容 hash 已变化
// result.unchanged：依赖集合命中，但只是 CRLF/LF 差异或内容实际未变
```

也可以在文件变化后重新构建：

```js
const rebuild = await planner.rebuild(programId, [
  { stage: 'vertex', file: vertexFile },
  { stage: 'fragment', file: fragmentFile }
]);

rebuild.changed; // true/false
rebuild.previousHash;
rebuild.nextHash;
```

## 自定义虚拟文件系统

引擎可注入 `readFile(path)`，从资源包、内存虚拟文件系统或构建产物中读取源码：

```js
const result = await expandStage('compute', '/virtual/main.comp', {
  readFile: async (path) => virtualFileSystem.read(path),
  root: '/virtual',
  macros: { THREAD_GROUP_SIZE: 64 }
});
```

未注入 reader 时，默认使用 `node:fs/promises.readFile` 读取磁盘。

## 宏与表达式

支持：

- 对象式：`#define MAX_LIGHTS 8`
- 函数式：`#define ADD(a, b) ((a) + (b))`
- 显式输入：`true` 规范化为 `1`，数字和布尔以外的值转换为字符串
- `defined(X)`、`defined X`
- 算术、位运算、比较、逻辑运算、三元表达式、括号
- 十六进制和八进制整数；未定义标识符在 `#if` 中按 `0` 处理

重复函数参数、参数数量错误、除零、未闭合表达式等错误会抛出 `ShaderPlanError`，其中包含 `code`、`file` 和 `line`。

## 资源反射

识别以下形式：

```glsl
layout(set = 0, binding = 0) uniform CameraBlock {
  mat4 viewProjection;
} camera;

layout(set = 1, binding = 2) uniform sampler2D shadowMap;
layout(set = 1, binding = 3) uniform texture2D colorTexture;
layout(set = 2, binding = 1) buffer readonly ParticleBuffer {
  vec4 positions[];
} particles;

uniform vec4 plainColor;
```

没有显式 binding 的普通 uniform 会被反射，但 `binding` 为 `null`，不参与槽位冲突检测。

## 错误对象

```js
import { ErrorCode, ShaderPlanError } from 'shader-variant-planner';

try {
  await expandStage('vertex', entryFile);
} catch (error) {
  if (error instanceof ShaderPlanError) {
    error.code;
    error.file;
    error.line;
    error.message;
  }
}
```

错误码：

- `INCLUDE_NOT_FOUND`
- `INCLUDE_CYCLE`
- `DUPLICATE_PARAMETER`
- `UNCLOSED_CONDITIONAL`
- `ILLEGAL_DIRECTIVE`
- `MACRO_ARG_COUNT`
- `EXPRESSION_ERROR`
- `SLOT_CONFLICT`
- `BAD_STAGE`

## 已知边界

- 不实现 GLSL 编译、校验、代码生成、渲染器或 UI；语法反射是轻量文本解析，不是完整 GLSL 编译器。
- 不支持 `#elif`、`#error`、`#pragma`、`#line`、`#if` 中的宏形式 include；`#version`、`#extension` 等可通过 `permittedDirectives` 原样保留。
- 函数式宏支持参数替换和递归保护，不实现字符串化 `#`、token 拼接 `##`、可变参数 `...` 与 `__VA_ARGS__`。
- 条件表达式面向引擎宏开关和整数常量，不支持浮点复杂求值以外的完整 C 预处理语义。
- 资源反射覆盖常见 GLSL/Vulkan 风格 uniform block、buffer block、sampler、texture 和普通 uniform；极冷门声明或复杂宏生成的声明可能需要先展开后再由引擎编译器处理。
- include 路径按字符串规范化比较，硬链接或指向同一文件的不同路径不会自动去重为同一个逻辑资源。
