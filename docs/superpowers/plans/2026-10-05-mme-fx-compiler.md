# MME 互換モード 第 1 の計画: FX コンパイラ 実装計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MME の .fx（DirectX 9 の HLSL エフェクト）を読み、型を付けて、WebGL2 の GLSL ES 3.00 とエフェクトの記述（`EffectDesc`）に変換する純粋な関数 `compileEffect` を `src/core/fx/` に作る。

**Architecture:** 前処理 → 構文解析 → 型チェック → GLSL の書き出し、の 4 段階を別々のファイルにし、段階ごとに vitest で確かめる。すべての字句は元のファイル・行・列を持ち歩く。最後に Ray-MMD 1.5.2 の全 .fx を変換し、本物の WebGL2（Playwright）でリンクと値を確かめる。

**Tech Stack:** TypeScript 7・vitest・Playwright（Chromium。CI は SwiftShader）・`@shaderfrog/glsl-parser`（devDependencies。GLSL として読めるかの確かめだけ）

**Spec:** `docs/superpowers/specs/2026-10-05-mme-fx-compiler-design.md`（実装する人は必ず両方を読む）

## Global Constraints

- 出力は **GLSL ES 3.00** だけ。先頭は必ず次の 6 行:
  `#version 300 es` / `precision highp float;` / `precision highp int;` / `precision highp sampler2D;` / `precision highp sampler3D;` / `precision highp samplerCube;`
- `src/core/fx/` は three.js・DOM・WebGL を import しない。同期で動く。
- `src/core/fx/` の中の import は **拡張子 `.ts` まで書く**（`import { lex } from './lexer.ts'`）。`node scripts/fx-check.ts` で直接動かすため。そのために `src/core/i18n.ts` の `import { Emitter } from './events'` を `'./events.ts'` に変える（Task 1）。
- 画面やエラーに出す文は `t('日本語')` で書き、**同じタスクの中で** `src/i18n/en.ts`・`zh-Hans.ts`・`zh-Hant.ts` に訳を足す（`src/i18n/i18n.test.ts` が訳のない文で落ちる）。
- テストはエラーの文ではなく `code` で確かめる。
- 型の誤りは最大 20 個（21 個目で `FX-TYPE-TOO-MANY` を足して止める）。`#include` の深さの上限は 64。
- コメントは、まわりのコードと同じく日本語で短く。
- 各タスクの終わりに `npm run lint` と `npx tsc -b` も通す。コミットは日本語の 1 行の要約と、末尾に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。
- Ray-MMD のファイルを GitHub から取ってくる前に、ユーザーに確認する（Task 12）。

## 仕様の補足（設計書からの具体化）

実装中に迷わないよう、設計書で決めきっていなかった点をここで決める。

1. **パスの基準**: `compileEffect(entry, readFile, options)` の `entry` も、`readFile` に渡すパスも、**呼び出し側が決めた 1 つのフォルダ（ルート）からの相対パス**にする（例: ルート = `third_party/ray-mmd-1.5.2`、`entry = 'Materials/material_2.0.fx'`、include は `'Materials/../material_common_2.0.fxsub'` を正規化した `'material_common_2.0.fxsub'` で `readFile` が呼ばれる）。`listFiles` もルートからの相対パスの一覧。設計書の「.fx からの相対パス」より、`..` を含む include を素直に扱える。
2. **Shift-JIS の読み方**: `core/sjis.ts` は書き出し専用なので、読むのはブラウザと Node にある `new TextDecoder('shift_jis')` を使う。
3. **ray.conf の切り替え**: 設計書の「AA_QUALITY 1〜6」は誤りで、1.5.2 の `ray.conf` の説明は 0〜5（6 の TAA のファイルは 1.5.2 に入っていない）。切り替えの組み合わせは、`ray.conf` の各 `#define` の直前にある `// N : …` の行から値の一覧を読み、**1 つの `#define` だけをその値に変えたもの**を全部試す（下の Task 12）。
4. **`ddy` の向き**: `ddy(x)` → `(-mme_flipY * dFdy(x))`（`mme_flipY = 1` のとき、D3D の画面の上が GL の上に来る）。
5. **`VPOS`**: `vec2(gl_FragCoord.x - 0.5, (mme_flipY < 0.0 ? gl_FragCoord.y : mme_viewport.y - gl_FragCoord.y) - 0.5)`。`mme_viewport`（`uniform vec2`、描画先の大きさ）は `VPOS` を使う pass にだけ入れる。
6. **頂点の入力の型**: 頂点の入力はいつも `in vec4 a_<SEM>;` にして、引数の型に合わせて切り詰める（WebGL も D3D も、足りない成分は (0, 0, 0, 1) で埋めるので同じ）。`AttributeRef.type` はいつも `'float4'`。
7. **頂点からフラグメントへ**: いつも `vec4 v_<SEM>` にする。書くときは足りない成分を (0, 0, 0, 1) で埋め、読むときは切り詰める（`TEXCOORD0` を頂点で float4、フラグメントで float2 として使うのはよくある書き方）。
8. **`const` のグローバル変数**: `static` がなく `const` があり、セマンティクスがなく、初期値が定数に計算できれば GLSL の `const`。それ以外の `static` でない変数は uniform。
9. **初期値のない局所変数**: 0 で初期化して書き出す（fxc でも中身は決まっていない。描画を機械によらず同じにするため）。
10. **for の初期化の変数**: HLSL の古い決まりどおり、ループのあとも見える。2 つ目の `for (int i = …)` が同じ名前・同じ型なら同じ変数を使い直す（型が違えば `FX-TYPE-REDEFINED`）。
11. **予期しない例外**: コンパイラの不具合で例外が出たら、`FX-INTERNAL` のエラー（場所はエントリーの 1 行 1 列）にして `ok: false` で返す。`compileEffect` は例外を外に出さない。

## Review Focus

テストのどれもが自然には触れないが、使う人がいちばん出会いそうなもの（上から順に起きやすい）。それぞれ、持ち主のタスクにテストを足してある。

1. **頂点とフラグメントで同じ構造体を使い、`POSITION` のメンバーがある**（MME でいちばんよくある書き方）。フラグメントで `POSITION` を読まなければ、警告もエラーもなく通るべき → Task 10 のテスト「同じ構造体を頂点とフラグメントで使う」。
2. **GLSL の予約語を名前に使う**（`input`・`output`・`sample`・`filter`・`mix`・`mod` など）→ Task 9 の `glslName` のテストと、Task 10 のテスト「予約語の名前の uniform と局所変数」。
3. **`#include "..\\Shader\\Common.fxsub"`**（`\`・`..`・大文字小文字の違いが一度に出る）→ Task 1 の `resolveFile` のテストと、Task 3 のテスト。
4. **Shift-JIS の日本語のコメントと、注釈の日本語の文字列**（`string UIName = "明るさ";`）。文字列が正しく読めて `annotations` に入るべき → Task 11 のテスト「Shift-JIS の注釈」。
5. **引数付きのマクロの名前を、括弧なしで使う**（`#define min3(a,b,c) …` のあとの `min3` だけ）。展開せずにそのまま残すべき → Task 3 のテスト。

---

## ファイルの地図

| ファイル | 役割 | タスク |
|---|---|---|
| `src/core/fx/diagnostics.ts` | `Loc`・`Diagnostic`・code の一覧・`Diagnostics`（集める箱）・`FxError` | 1 |
| `src/core/fx/source.ts` | 文字コードの判定、パスの正規化、大文字小文字を無視したファイル探し | 1 |
| `src/core/fx/lexer.ts` | 字句（`Token`） | 2 |
| `src/core/fx/preprocess.ts` | 前処理（`#include`・`#define`・`#if` …）。字句の列を返す | 3 |
| `src/core/fx/types.ts` | HLSL の型・型の名前・暗黙の型変換・二項演算の結果の型 | 4 |
| `src/core/fx/intrinsics.ts` | 組み込み関数の表とオーバーロードの解決 | 4 |
| `src/core/fx/ast.ts` | AST の型（型チェックが書き足す欄も） | 5 |
| `src/core/fx/parser.ts` | 構文解析 | 5・6 |
| `src/core/fx/check.ts` | 型チェック・定数の計算・pass から使われる関数の洗い出し | 7 |
| `src/core/fx/script.ts` | Script の文字列 → 命令の列 | 8 |
| `src/core/fx/states.ts` | 描画ステート・サンプラーステートの正規化 | 8 |
| `src/core/fx/emit.ts` | 型・名前・式・文・関数の GLSL | 9 |
| `src/core/fx/entry.ts` | pass ごとの `main`・入出力・uniform の一覧（`Program`） | 10 |
| `src/core/fx/desc.ts` | 出力の型（`EffectDesc` など。型だけ） | 10 |
| `src/core/fx/index.ts` | `compileEffect` | 11 |
| `src/core/fx/fixtures/` | 自作の小さな .fx | 11 |
| `src/core/fx/testing/rayCorpus.ts` | Ray-MMD の見本を読む・ray.conf の切り替えを作る（テスト用） | 12 |
| `src/core/fx/corpus.test.ts` | Ray-MMD を全部変換するテスト | 12 |
| `third_party/ray-mmd-1.5.2/` | Ray-MMD の .fx・.fxsub・.conf と LICENSE.txt・README.md | 12 |
| `e2e/fx-webgl.spec.ts` | WebGL2 でのリンクと値の確かめ | 13 |
| `scripts/fx-check.ts`・`fx/README.md` | `npm run fx:check` と、Git に入れないエフェクト置き場 | 14 |

---

### Task 1: 診断・ソースの読み方・ファイル探し

**Files:**
- Create: `src/core/fx/diagnostics.ts`, `src/core/fx/source.ts`
- Modify: `src/core/i18n.ts:1`（`'./events'` → `'./events.ts'`）
- Test: `src/core/fx/source.test.ts`, `src/core/fx/diagnostics.test.ts`

**Interfaces:**
- Produces:

```ts
// diagnostics.ts
export interface Loc { file: string; line: number; column: number; includedFrom?: { file: string; line: number }[] }
export type DiagCode =
  | 'FX-IO-NOT-FOUND' | 'FX-PP-INCLUDE-NOT-FOUND' | 'FX-PP-INCLUDE-DEPTH' | 'FX-PP-DIRECTIVE' | 'FX-PP-ERROR'
  | 'FX-PP-UNTERMINATED-IF' | 'FX-PP-MACRO-ARGS' | 'FX-LEX-CHAR' | 'FX-LEX-UNTERMINATED' | 'FX-PARSE'
  | 'FX-TYPE-UNDEFINED' | 'FX-TYPE-MISMATCH' | 'FX-TYPE-NO-OVERLOAD' | 'FX-TYPE-AMBIGUOUS' | 'FX-TYPE-SWIZZLE'
  | 'FX-TYPE-LVALUE' | 'FX-TYPE-CONST' | 'FX-TYPE-REDEFINED' | 'FX-TYPE-TOO-MANY'
  | 'FX-PASS-FUNCTION' | 'FX-PASS-SEMANTIC' | 'FX-UNSUPPORTED' | 'FX-INTERNAL'
  | 'FX-WARN-TRUNCATION' | 'FX-WARN-REDEFINE-MACRO' | 'FX-WARN-STATE' | 'FX-WARN-STATE-EXPR' | 'FX-WARN-SCRIPT' | 'FX-WARN-SEMANTIC';
export interface Diagnostic extends Loc { severity: 'error' | 'warning'; code: DiagCode; message: string }
export class FxError extends Error {}                       // 続けられない誤り。投げる前に必ず Diagnostics に積む
export class Diagnostics {
  readonly errors: Diagnostic[]; readonly warnings: Diagnostic[];
  error(code: DiagCode, loc: Loc, message: string): void;   // 20 個を超えたら FX-TYPE-TOO-MANY を積んで FxError を投げる
  warn(code: DiagCode, loc: Loc, message: string): void;
  fatal(code: DiagCode, loc: Loc, message: string): never;  // 積んで FxError を投げる
}
// source.ts
export interface FileAccess { readFile(path: string): Uint8Array | null; listFiles?: () => string[] }
export function decodeSource(bytes: Uint8Array): string;             // 改行は '\n' にそろえる
export function normalizePath(path: string): string;                 // '\' → '/'、'.' と '..' をたたむ (先頭の '..' は残す)、'//' と先頭の './' を消す
export function dirname(path: string): string;                       // 'a/b/c.fx' → 'a/b'、'c.fx' → ''
export function joinPath(dir: string, rel: string): string;          // normalizePath(dir + '/' + rel)。dir が '' なら rel
export function resolveFile(access: FileAccess, path: string): { path: string; bytes: Uint8Array } | null;
```

- [ ] **Step 1: 失敗するテストを書く**

```ts
// source.test.ts
describe('ソースの読み方', () => {
  it('BOM 付きの UTF-8・UTF-16LE・UTF-16BE を読む', ...);       // 'ab' がそれぞれ 'ab' になる
  it('UTF-8 として正しくなければ Shift-JIS として読む', () => {
    expect(decodeSource(encodeShiftJis('// 明るさ\r\nfloat a;'))).toBe('// 明るさ\nfloat a;');
  });
  it('CR だけの改行も \\n にする', () => expect(decodeSource(utf8('a\rb'))).toBe('a\nb'));
});
describe('パス', () => {
  it('正規化する', () => {
    expect(normalizePath('Shader\\..\\shader\\.\\math.fxsub')).toBe('shader/math.fxsub');
    expect(normalizePath('../a//b')).toBe('../a/b');
    expect(joinPath('Materials/Editor', '../../material_common_2.0.fxsub')).toBe('material_common_2.0.fxsub');
    expect(dirname('a/b/c.fx')).toBe('a/b'); expect(dirname('c.fx')).toBe('');
  });
  it('書かれたとおりになければ、大文字小文字を無視して listFiles から探す', () => {
    const files = { 'Shader/Math.fxsub': utf8('x') };
    const access = { readFile: (p: string) => files[p] ?? null, listFiles: () => Object.keys(files) };
    expect(resolveFile(access, 'x\\..\\shader\\math.FXSUB')?.path).toBe('Shader/Math.fxsub');
    expect(resolveFile({ readFile: access.readFile }, 'shader/math.fxsub')).toBeNull(); // listFiles がなければ探さない
  });
});
// diagnostics.test.ts
it('20 個を超える誤りで FX-TYPE-TOO-MANY を足して止める', () => {
  const d = new Diagnostics();
  for (let i = 0; i < 20; i++) d.error('FX-TYPE-MISMATCH', loc, 'x');
  expect(() => d.error('FX-TYPE-MISMATCH', loc, 'x')).toThrow(FxError);
  expect(d.errors.map(e => e.code).at(-1)).toBe('FX-TYPE-TOO-MANY');
});
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/fx` / Expected: FAIL（モジュールがない）
- [ ] **Step 3: 実装する** — `decodeSource` は BOM → `new TextDecoder('utf-8', { fatal: true })` → 失敗したら `new TextDecoder('shift_jis')`。`resolveFile` は `normalizePath` してから `readFile`、なければ `listFiles()` の各要素を `normalizePath(x).toLowerCase()` で比べる。`FX-TYPE-TOO-MANY` の文は `t('誤りが多いので、ここで止めました')`。`src/core/i18n.ts` の import を `'./events.ts'` にする。訳を 3 つの辞書に足す。
- [ ] **Step 4: 通ることを確かめる** — Run: `npx vitest run src/core/fx src/i18n` / Expected: PASS
- [ ] **Step 5: コミット** — `git add src/core/fx src/core/i18n.ts src/i18n && git commit -m "FX コンパイラ: 診断とソースの読み方"`

---

### Task 2: 字句解析

**Files:**
- Create: `src/core/fx/lexer.ts`
- Test: `src/core/fx/lexer.test.ts`

**Interfaces:**
- Consumes: `Loc`, `Diagnostics`（Task 1）
- Produces:

```ts
export type TokenKind = 'ident' | 'number' | 'string' | 'punct' | 'eof';
export interface Token { kind: TokenKind; text: string; loc: Loc; lineStart: boolean; spaceBefore: boolean }
export function lex(text: string, file: string, diags: Diagnostics): Token[];   // 最後は eof。コメントは捨てる
export function numberValue(tok: Token): { value: number; isFloat: boolean };
```

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('行と列を数え、行末の \\ でつないだ行も 1 行として読む', () => {
  const t = lex('float a;\n#define X \\\n 1\n  b', 'f.fx', new Diagnostics());
  expect(t.map(x => x.text)).toEqual(['float', 'a', ';', '#', 'define', 'X', '1', 'b', '']);
  expect(t[3]).toMatchObject({ lineStart: true, loc: { line: 2, column: 1 } });
  expect(t[7].loc).toMatchObject({ line: 4, column: 3 });
});
it('数の書き方', () => {
  const v = (s: string) => numberValue(lex(s, 'f', new Diagnostics())[0]);
  expect(v('1.0f')).toEqual({ value: 1, isFloat: true }); expect(v('.5')).toEqual({ value: 0.5, isFloat: true });
  expect(v('1e-5')).toEqual({ value: 1e-5, isFloat: true }); expect(v('0x1F')).toEqual({ value: 31, isFloat: false });
  expect(v('2h')).toEqual({ value: 2, isFloat: true }); expect(v('10u')).toEqual({ value: 10, isFloat: false });
});
it('2 文字以上の記号と文字列', () => {
  expect(lex('a<<=b##c "x\\"y"', 'f', new Diagnostics()).map(x => x.text)).toEqual(['a', '<<=', 'b', '##', 'c', '"x\\"y"', '']);
});
it('閉じていないコメント・文字列は FX-LEX-UNTERMINATED、知らない文字は FX-LEX-CHAR', ...);
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/fx/lexer.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — 記号は長い順に照らす（`<<=` `>>=` `...` `##` `++` `--` `&&` `||` `==` `!=` `<=` `>=` `+=` `-=` `*=` `/=` `%=` `&=` `|=` `^=` `<<` `>>` `->` と 1 文字の記号）。文字列の `text` は引用符ごと元のまま（中身を取り出すのは構文解析）。誤りは `diags.fatal`。
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "FX コンパイラ: 字句解析"`

---

### Task 3: 前処理

**Files:**
- Create: `src/core/fx/preprocess.ts`
- Test: `src/core/fx/preprocess.test.ts`

**Interfaces:**
- Consumes: `lex`, `Token`（Task 2）、`FileAccess`, `resolveFile`, `joinPath`, `dirname`, `decodeSource`（Task 1）
- Produces:

```ts
export interface PreprocessOptions { defines?: Record<string, string> }
// マクロを展開し、指令を取り除いた字句の列 (最後は eof)。マクロから出た字句の loc は、使った場所
export function preprocess(entry: string, access: FileAccess, options: PreprocessOptions, diags: Diagnostics): Token[];
```

- [ ] **Step 1: 失敗するテストを書く**（テスト用に `files(record)` で `FileAccess` を作る小さな関数を置く）

```ts
it('#include を、include したファイルのフォルダ → エントリーのフォルダの順に、大文字小文字を無視して探す', () => {
  const fs = files({ 'fx/main.fx': '#include "..\\Shader\\common.FXSUB"\nB', 'shader/Common.fxsub': 'A' });
  const t = preprocess('fx/main.fx', fs, {}, new Diagnostics());
  expect(texts(t)).toEqual(['A', 'B']);
  expect(t[0].loc).toMatchObject({ file: 'shader/Common.fxsub', line: 1, includedFrom: [{ file: 'fx/main.fx', line: 1 }] });
});
it('引数付きマクロ・# と ##・自分自身は展開しない', () => {
  const src = '#define CAT(a,b) a##b\n#define STR(x) #x\n#define SELF SELF+1\nCAT(fo,o) STR(z) SELF';
  expect(texts(run(src))).toEqual(['foo', '"z"', 'SELF', '+', '1']);
});
it('引数付きマクロの名前だけ (括弧なし) は展開しない', () => {
  expect(texts(run('#define min3(a,b,c) min(a,min(b,c))\nfloat min3;'))).toEqual(['float', 'min3', ';']);
});
it('#if・#elif・defined・知らない名前は 0', () => {
  expect(texts(run('#define Q 2\n#if Q == 1\na\n#elif defined(Q) && !NOPE\nb\n#else\nc\n#endif'))).toEqual(['b']);
});
it('偽の #if の中の #include は読まない', () => expect(texts(run('#if 0\n#include "nope.fx"\n#endif\nx'))).toEqual(['x']));
it('options.defines は最初から定義され、ファイルの #define で違う値にすると FX-WARN-REDEFINE-MACRO', ...);
it('見つからない include は FX-PP-INCLUDE-NOT-FOUND、深さ 65 で FX-PP-INCLUDE-DEPTH、#error は FX-PP-ERROR、閉じていない #if は FX-PP-UNTERMINATED-IF、引数の数が違えば FX-PP-MACRO-ARGS', ...);
it('エントリーがなければ FX-IO-NOT-FOUND', ...);
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/fx/preprocess.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — 指令は `lineStart` の `#` で見分ける。`#pragma`・`#line` は読み飛ばす。`#if` の式は整数（`defined`・`! ~ * / % + - << >> < > <= >= == != & ^ | && || ?:`・括弧）。展開中のマクロの名前の集合を持って、自分自身を展開しない。`#include <x>` も `"x"` と同じに扱う。
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "FX コンパイラ: 前処理"`

---

### Task 4: 型と組み込み関数の表

**Files:**
- Create: `src/core/fx/types.ts`, `src/core/fx/intrinsics.ts`
- Test: `src/core/fx/types.test.ts`, `src/core/fx/intrinsics.test.ts`

**Interfaces:**
- Produces:

```ts
// types.ts
export type Scalar = 'float' | 'int' | 'uint' | 'bool';
export type Dim = '1D' | '2D' | '3D' | 'CUBE';
export type Type =
  | { k: 'scalar'; s: Scalar }
  | { k: 'vector'; s: Scalar; n: 2 | 3 | 4 }
  | { k: 'matrix'; s: Scalar; rows: 1 | 2 | 3 | 4; cols: 1 | 2 | 3 | 4 }   // HLSL の floatRxC (R 行 C 列)
  | { k: 'array'; of: Type; length: number }
  | { k: 'struct'; name: string; fields: { name: string; type: Type; semantic: string | null }[] }
  | { k: 'sampler'; dim: Dim | null }       // null は `sampler` (向きは使い方で決まる)
  | { k: 'texture'; dim: Dim | null }       // null は `texture`
  | { k: 'string' } | { k: 'void' };
export function builtinType(name: string): Type | null;  // 'half3'→float3, 'double'→float, 'float1'→float, 'float4x3', 'bool2', 'sampler2D', 'textureCUBE', 'string', 'void'
export function vectorOf(s: Scalar, n: number): Type;     // n = 1 ならスカラー
export function matrixOf(s: Scalar, rows: number, cols: number): Type;
export function typeName(t: Type): string;               // HLSL の書き方: 'float4x3'・'float'・'S'・'float4[3]'
export function sameType(a: Type, b: Type): boolean;
export function componentCount(t: Type): number;
export interface Conversion { cost: number; truncates: boolean }
export function conversion(from: Type, to: Type): Conversion | null;
export function binaryResultType(op: string, a: Type, b: Type): { type: Type; truncates: boolean } | null;
// intrinsics.ts
export type IntrinsicResolution = { ok: true; ret: Type; params: Type[] } | { ok: false; reason: 'no-overload' | 'ambiguous' };
export function isIntrinsic(name: string): boolean;
export function resolveIntrinsic(name: string, args: Type[]): IntrinsicResolution;
export const UNSUPPORTED_INTRINSICS: readonly string[];   // ['noise', 'frexp', 'dst']
```

型変換の決まり（`conversion` の cost）: 同じ型 0／スカラーの種類だけ違う（同じ形）1／スカラー → ベクトル・行列（広げる）2（種類も違えば 3）／ベクトル → 小さいベクトル・スカラー、行列 → 行も列も小さい行列（切り詰め、`truncates: true`）4／成分の数が同じベクトルと行列 5／構造体・配列は同じ型だけ／`sampler`（dim null）はどの dim のサンプラーとも 0。

二項演算（`binaryResultType`）: 算術 `+ - * / %` は、スカラーと何かなら相手の形、同じ種類どうしなら小さいほうの形（違えば `truncates`）、成分の種類はどちらかが float なら float、bool は int にする。比較 `< > <= >= == !=` と論理 `&& ||` は同じ形の bool。ビット演算 `& | ^ << >> ~` は null（SM3 にない）。**行列 `*` 行列は成分ごとの積**（HLSL の決まり。行列の積は `mul`）。

組み込み関数（ほかの名前は組み込み関数ではない）: `abs acos all any asin atan atan2 ceil clamp clip cos cosh cross D3DCOLORtoUBYTE4 ddx ddy degrees determinant distance dot exp exp2 faceforward floor fmod frac fwidth isfinite isinf isnan ldexp length lerp lit log log10 log2 max min modf mul normalize pow radians reflect refract round rsqrt saturate sign sin sincos sinh smoothstep sqrt step tan tanh transpose trunc` と、テクスチャの `tex1D tex2D tex3D texCUBE`（2 引数と、勾配付きの 4 引数）と、それぞれの `lod bias proj grad` 付き（`tex2Dlod(s, float4)` など）。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('型の名前', () => {
  expect(typeName(builtinType('half4x3')!)).toBe('float4x3'); expect(builtinType('float1')).toEqual({ k: 'scalar', s: 'float' });
});
it('型変換の cost', () => {
  expect(conversion(F, F4)).toEqual({ cost: 2, truncates: false });
  expect(conversion(F4, F3)).toEqual({ cost: 4, truncates: true });
  expect(conversion(F3, F4)).toBeNull();
  expect(conversion(M44, M33)).toEqual({ cost: 4, truncates: true });
});
it('二項演算の結果', () => {
  expect(binaryResultType('+', F4, F)?.type).toEqual(F4);
  expect(binaryResultType('*', F4, F3)).toEqual({ type: F3, truncates: true });
  expect(binaryResultType('<', F3, F3)?.type).toEqual(vectorOf('bool', 3));
  expect(binaryResultType('*', M44, M44)?.type).toEqual(M44);
  expect(binaryResultType('&', I, I)).toBeNull();
});
it('mul のかたち', () => {
  expect(resolveIntrinsic('mul', [F4, matrixOf('float', 4, 3)])).toMatchObject({ ok: true, ret: F3 });
  expect(resolveIntrinsic('mul', [matrixOf('float', 3, 4), F4])).toMatchObject({ ok: true, ret: F3 });
  expect(resolveIntrinsic('mul', [F3, F3])).toMatchObject({ ok: true, ret: F });
});
it('広げてから選ぶ・テクスチャ', () => {
  expect(resolveIntrinsic('lerp', [F3, F3, F])).toMatchObject({ ok: true, ret: F3, params: [F3, F3, F3] });
  expect(resolveIntrinsic('tex2D', [{ k: 'sampler', dim: null }, F2])).toMatchObject({ ok: true, ret: F4 });
  expect(resolveIntrinsic('texCUBE', [{ k: 'sampler', dim: '2D' }, F3])).toEqual({ ok: false, reason: 'no-overload' });
  expect(resolveIntrinsic('dot', [F3, F4])).toMatchObject({ ok: true, ret: F });  // 切り詰めて選ぶ
});
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/fx/types.test.ts src/core/fx/intrinsics.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — 組み込み関数は「成分ごと（T = float のスカラー・ベクトル・行列）」「ベクトル用」「特別なもの（mul・dot・cross・all/any・テクスチャ・sincos・modf・lit・determinant・transpose・D3DCOLORtoUBYTE4）」の 3 種類の表にし、候補ごとに引数の `conversion` の cost の合計がいちばん小さいものを選ぶ（同点が 2 つ以上なら ambiguous）。`abs min max clamp sign` は int 版も持つ。
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "FX コンパイラ: 型と組み込み関数の表"`

---

### Task 5: AST と構文解析 (1) — 型・式・文・関数・構造体

**Files:**
- Create: `src/core/fx/ast.ts`, `src/core/fx/parser.ts`
- Test: `src/core/fx/parser.test.ts`

**Interfaces:**
- Consumes: `Token`（Task 2）、`Type`, `builtinType`（Task 4）、`Diagnostics`
- Produces（Task 6・7・9・10 が使う。`?` の付いた欄は型チェックが書き足す）:

```ts
export type TypeRef = { kind: 'builtin'; type: Type; loc: Loc } | { kind: 'named'; name: string; loc: Loc };
export type Expr = (
  | { kind: 'number'; value: number; isFloat: boolean }
  | { kind: 'bool'; value: boolean }
  | { kind: 'string'; value: string }                                  // 注釈とステートの値だけ
  | { kind: 'ident'; name: string; sym?: Sym }
  | { kind: 'unary'; op: '-' | '+' | '!' | '~' | '++' | '--'; postfix: boolean; operand: Expr }
  | { kind: 'binary'; op: string; left: Expr; right: Expr }
  | { kind: 'assign'; op: '=' | '+=' | '-=' | '*=' | '/=' | '%='; target: Expr; value: Expr }
  | { kind: 'ternary'; cond: Expr; then: Expr; else: Expr }
  | { kind: 'call'; callee: string; args: Expr[]; target?: CallTarget }
  | { kind: 'construct'; type: TypeRef; args: Expr[] }                 // float4(...)
  | { kind: 'cast'; type: TypeRef; value: Expr }                       // (float3)x・(S)0
  | { kind: 'member'; object: Expr; name: string; access?: MemberAccess }
  | { kind: 'index'; object: Expr; index: Expr }
  | { kind: 'initList'; items: Expr[] }                                // { a, b }
  | { kind: 'sequence'; items: Expr[] }                                // a, b (for の中)
  | { kind: 'samplerState'; states: StateAssign[] }
  | { kind: 'convert'; to: Type; value: Expr }                         // 型チェックが入れる暗黙の型変換
) & { loc: Loc; type?: Type };
export type Sym = { kind: 'global'; name: string } | { kind: 'local'; decl: VarDecl | ParamNode };
export type CallTarget = { kind: 'function'; fn: FunctionDecl } | { kind: 'intrinsic'; name: string; params: Type[] };
export type MemberAccess =
  | { kind: 'swizzle'; comps: number[] }                               // 0〜3
  | { kind: 'field'; name: string }
  | { kind: 'matrix'; elems: [row: number, col: number][] };           // ._m01・._12 (0 から数えた行と列)
export type Stmt = (
  | { kind: 'block'; body: Stmt[] } | { kind: 'var'; decls: VarDecl[] } | { kind: 'expr'; expr: Expr }
  | { kind: 'if'; cond: Expr; then: Stmt; else: Stmt | null }
  | { kind: 'for'; init: Stmt | null; cond: Expr | null; step: Expr | null; body: Stmt }
  | { kind: 'while'; cond: Expr; body: Stmt } | { kind: 'do'; body: Stmt; cond: Expr }
  | { kind: 'switch'; value: Expr; cases: { value: Expr | null; body: Stmt[] }[] }
  | { kind: 'break' } | { kind: 'continue' } | { kind: 'discard' } | { kind: 'return'; value: Expr | null } | { kind: 'empty' }
) & { loc: Loc };
export type Storage = 'static' | 'const' | 'uniform' | 'shared' | 'extern' | 'volatile' | 'row_major' | 'column_major';
export interface AnnotationNode { type: TypeRef; name: string; value: Expr; loc: Loc }
export interface VarDecl { name: string; type: TypeRef; arrayDims: (Expr | null)[]; storage: Storage[]; semantic: string | null;
                           annotations: AnnotationNode[]; init: Expr | null; loc: Loc; resolved?: Type; reuses?: VarDecl }
export interface ParamNode { name: string; type: TypeRef; arrayDims: (Expr | null)[]; modifier: 'in' | 'out' | 'inout' | 'uniform';
                             semantic: string | null; init: Expr | null; loc: Loc; resolved?: Type }
export interface FunctionDecl { kind: 'function'; name: string; ret: TypeRef; retSemantic: string | null; params: ParamNode[];
                                body: Stmt | null; loc: Loc }          // body null はプロトタイプ
export interface StructDecl { kind: 'struct'; name: string; fields: { name: string; type: TypeRef; arrayDims: (Expr | null)[]; semantic: string | null; loc: Loc }[]; loc: Loc }
export interface TypedefDecl { kind: 'typedef'; name: string; type: TypeRef; arrayDims: (Expr | null)[]; loc: Loc }
export interface GlobalDecl { kind: 'global'; decl: VarDecl }
export interface ShaderCompile { kind: 'compile'; profile: string; fn: string; args: Expr[]; loc: Loc }
export interface StateAssign { name: string; index: number | null; value: Expr | ShaderCompile; loc: Loc }
export interface PassNode { name: string; annotations: AnnotationNode[]; states: StateAssign[]; loc: Loc }
export interface TechniqueNode { kind: 'technique'; name: string; annotations: AnnotationNode[]; passes: PassNode[]; loc: Loc }
export type TopLevel = GlobalDecl | FunctionDecl | StructDecl | TypedefDecl | TechniqueNode;
export interface FileNode { items: TopLevel[] }
// parser.ts
export function parse(tokens: Token[], diags: Diagnostics): FileNode;   // 最初の構文の誤りで FX-PARSE を fatal
```

- [ ] **Step 1: 失敗するテストを書く**（このタスクでは technique・注釈・sampler_state はまだ。`parseSrc(s)` = `parse(lex(s, 'f.fx', d), d)`）

```ts
it('関数・引数の修飾子とセマンティクス', () => {
  const f = parseSrc('float4 VS(in float4 p : POSITION, out float2 t : TEXCOORD0, uniform float2 o) : POSITION { t = o; return p; }').items[0] as FunctionDecl;
  expect(f).toMatchObject({ name: 'VS', retSemantic: 'POSITION', params: [{ modifier: 'in', semantic: 'POSITION' }, { modifier: 'out' }, { modifier: 'uniform', semantic: null }] });
});
it('演算子の優先順位と結合', () => {
  expect(show(expr('a = b ? c : d + e * f'))).toBe('(a = (b ? c : (d + (e * f))))');
  expect(show(expr('-x.y[2]++'))).toBe('(-((x.y)[2])++)');
});
it('キャストと括弧の見分け (構造体と typedef の名前を覚える)', () => {
  const file = parseSrc('struct S { float a : TEXCOORD0; }; typedef float3 V; float f() { S s = (S)0; V v = (V)1; return (a)+b; }');
  // (S)0 と (V)1 は cast、(a)+b は binary
});
it('グローバル変数: 記憶域・配列・カンマで分けた宣言・register は読み飛ばす', () => {
  const items = parseSrc('static const float2 k[2] = { {1,2}, {3,4} }, j = 0; float4x4 W : WORLD register(c0);').items;
  expect(items).toHaveLength(3);
});
it('vector<float, 3> と matrix<float, 4, 4>', ...);
it('for・while・do・switch・discard・属性 [unroll] は読み飛ばす', ...);
it('閉じていない括弧は FX-PARSE で、場所は元の行と列', ...);
it('SM4 以降の書き方 (cbuffer・tbuffer・Texture2D・SamplerState・t.Sample(…)) と asm は FX-UNSUPPORTED (FX-PARSE ではなく)', ...);
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/fx/parser.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — 再帰下降。`(` のあとが型の名前（組み込みの型・ここまでに出た構造体と typedef）で `)` が続けば cast。隣り合う文字列の字句は 1 つにつなぐ。`>>` を `>` 2 つとして読む必要がある所（`vector<float, vector<…>>` は出てこないので、注釈の閉じだけ）は Task 6 で扱う。`asm`・`cbuffer`・`tbuffer`・`Texture1D/2D/3D/Cube`・`SamplerState`・`SamplerComparisonState`、テクスチャの変数のメソッド呼び出し（`.Sample(`・`.Load(` など）が出たら `FX-UNSUPPORTED`（どれも `diags.fatal`）。
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "FX コンパイラ: 構文解析 (式・文・関数)"`

---

### Task 6: 構文解析 (2) — 注釈・sampler_state・technique・pass

**Files:**
- Modify: `src/core/fx/parser.ts`
- Test: `src/core/fx/parser.test.ts`（足す）

**Interfaces:**
- Consumes/Produces: Task 5 の AST（`AnnotationNode`・`StateAssign`・`ShaderCompile`・`PassNode`・`TechniqueNode`・`samplerState`）

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('注釈と、#if をはさんでつないだ Script の文字列', () => {
  const src = 'technique T < string Script = "A=1;"\n#if 1\n"B=2;"\n#endif\n; > { pass P < string Script = "Draw=Buffer;"; > { ZEnable = false; } }';
  const t = parseFx(src).items[0] as TechniqueNode;  // parseFx は preprocess → parse
  expect(t.annotations[0]).toMatchObject({ name: 'Script', value: { kind: 'string', value: 'A=1;B=2;' } });
  expect(t.passes[0].states[0]).toMatchObject({ name: 'ZEnable', value: { kind: 'bool', value: false } });
});
it('compile と、引数付きの pass の関数', () => {
  const p = passOf('PixelShader = compile ps_3_0 Blur(Samp, float2(ViewportOffset.x, 0.0f));');
  expect(p.states[0].value).toMatchObject({ kind: 'compile', profile: 'ps_3_0', fn: 'Blur', args: [{ kind: 'ident' }, { kind: 'construct' }] });
});
it('sampler_state と Texture = <Tex> / (Tex)', () => {
  const g = parseSrc('sampler S = sampler_state { texture = <Tex>; MinFilter = LINEAR; AddressU = CLAMP; };').items[0] as GlobalDecl;
  expect(g.decl.init).toMatchObject({ kind: 'samplerState', states: [{ name: 'texture', value: { kind: 'ident', name: 'Tex' } }, { name: 'MinFilter' }, { name: 'AddressU' }] });
});
it('セマンティクスと注釈の付いたグローバル変数・注釈の閉じが >> でも読む', () => {
  parseSrc('float m : CONTROLOBJECT < string name = "ray_controller.pmx"; string item = "SunLight+"; >;');
  parseSrc('texture2D T : RENDERCOLORTARGET <float2 ViewportRatio = {1.0, 1.0}; string Format = "A16B16G16R16F";>;');
});
it('中身のない technique・ColorWriteEnable1 は index 1・asm は FX-UNSUPPORTED', ...);
it('マクロで書いた technique (Ray-MMD の OBJECT_TEC) を展開して読む', ...);
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/fx/parser.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — 注釈は `<` … `>`（閉じが `>>` の字句なら半分ずつ使う）。ステートの名前の最後の数字は `index` に分ける（`ColorWriteEnable1` → name `ColorWriteEnable`、index 1。`Texture[0]` の形も index）。`<Tex>` の値は `ident` にする。
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "FX コンパイラ: 構文解析 (technique・pass・注釈)"`

---

### Task 7: 型チェック

**Files:**
- Create: `src/core/fx/check.ts`
- Test: `src/core/fx/check.test.ts`

**Interfaces:**
- Consumes: AST（Task 5・6）、`types.ts`・`intrinsics.ts`（Task 4）
- Produces:

```ts
export type ConstValue = { kind: 'num'; type: Type; values: number[] } | { kind: 'str'; value: string };
// num の values は成分を並べたもの。行列は HLSL の行ごと (1 行目の C 個、2 行目 …)。bool は 0 / 1
export interface GlobalInfo { decl: VarDecl; type: Type; storage: 'uniform' | 'static' | 'const'; value: ConstValue | null; needsInit: boolean }
// needsInit: static で、初期値が定数に計算できない (main の最初で計算する)
export interface FunctionInfo { decl: FunctionDecl; params: Type[]; ret: Type }
export interface EntryInfo { fn: FunctionInfo; profile: string; uniformArgs: Expr[] }   // uniformArgs は型チェック済み (引数の型に変換済み)
export interface CheckedEffect {
  file: FileNode;
  globals: Map<string, GlobalInfo>;          // 宣言の順
  structs: Map<string, Type>;
  functions: FunctionInfo[];                 // pass から使われる (中身を確かめた) 関数だけ
  entries: Map<PassNode, { vs: EntryInfo | null; ps: EntryInfo | null }>;
  constEval(e: Expr): ConstValue | null;
}
export function check(file: FileNode, diags: Diagnostics): CheckedEffect;
```

決まり（設計書と「仕様の補足」8・10 に加えて）:
- 記憶域: `static` → static。「補足 8」の条件を満たす `const` → const。それ以外（記号なし・`uniform`・`extern`・`shared`・`volatile`）→ uniform。uniform の初期値が定数でなければ `FX-TYPE-CONST`。`row_major`・`column_major` は無視。
- グローバル変数の初期値と注釈はすべて確かめる（注釈の値は定数でなければ `FX-TYPE-CONST`）。関数の中身は、pass から（呼び出しをたどって）使われるものだけ確かめる。
- pass の `compile`: profile が `vs_2_0 vs_2_a vs_3_0 ps_2_0 ps_2_a ps_2_b ps_3_0` なら受け付け、`vs_1_*`・`ps_1_*`・それ以外は `FX-UNSUPPORTED`。関数がない・`uniform` の引数の数や型が合わなければ `FX-PASS-FUNCTION`。同じ名前の関数がいくつかあれば、`uniform` の引数が合うものを選ぶ。
- 暗黙の型変換はすべて `convert` の式を挟んで表す（代入・初期値・引数・return・条件（bool へ）・二項演算の両辺を結果の成分の種類へ）。切り詰めは `FX-WARN-TRUNCATION`。
- サンプラーの dim が null のグローバル変数は、`sampler_state` の Texture の型から、なければ最初に使ったテクスチャの関数から決めて、`GlobalInfo.type` に書く。食い違えば `FX-TYPE-MISMATCH`。
- スワズル: `xyzw` と `rgba` を混ぜない、1〜4 文字、型の成分の数の中。スカラーにも `x`/`r` だけ使える。重なりのあるスワズルへの代入は `FX-TYPE-LVALUE`。行列は `_m00`〜`_m33` と `_11`〜`_44` の並び。
- `noise` など `UNSUPPORTED_INTRINSICS` の呼び出し・関数の中の `static` 変数・構造体の uniform・int の行列・1xN の行列は `FX-UNSUPPORTED`。
- 定数の計算: 数・bool・コンストラクタ・単項と二項の演算・三項・const と static（定数の値があるもの）の参照・`lerp min max abs saturate sqrt pow floor ceil frac sin cos tan exp exp2 log log2 normalize length dot` を定数に対して。

- [ ] **Step 1: 失敗するテストを書く**（`checkSrc(src)` = 前処理 → 構文解析 → `check`）

```ts
it('static の初期値が uniform を使えば needsInit、定数なら値', () => {
  const c = checkSrc('float u; static float a = lerp(1, 2, u); static const float b = 2 * 3; const float4 BackColor = 0.0;' + PASS_USING('a + b'));
  expect(c.globals.get('a')).toMatchObject({ storage: 'static', needsInit: true });
  expect(c.globals.get('b')?.value).toEqual({ kind: 'num', type: F, values: [6] });
  expect(c.globals.get('BackColor')).toMatchObject({ storage: 'const', value: { values: [0, 0, 0, 0] } });
  expect(c.globals.get('u')?.storage).toBe('uniform');
});
it('暗黙の型変換に convert を挟み、切り詰めは警告', () => {
  const { checked, diags } = checkSrcWithDiags('float4 PS() : COLOR0 { float3 t = float4(1,2,3,4); return t.xyzz; }' + PS_PASS);
  expect(diags.warnings.map(w => w.code)).toEqual(['FX-WARN-TRUNCATION']);
});
it('使われていない関数の中の誤りでは失敗しない', () => {
  expect(() => checkSrc('float unused() { return nope; }' + PS_PASS_RETURNING('1'))).not.toThrow();
});
it('使われている関数の誤りは集めて出す (知らない名前・合わない引数)', () => {
  const d = diagsOf('float4 PS() : COLOR0 { return nope + tex2D(1, 2); }' + PS_PASS);
  expect(d.errors.map(e => e.code)).toEqual(['FX-TYPE-UNDEFINED', 'FX-TYPE-NO-OVERLOAD']);
});
it('pass の uniform の引数を関数の引数の型に変換し、数が違えば FX-PASS-FUNCTION', ...);
it('vs_1_1 は FX-UNSUPPORTED', ...);
it('for の変数はループのあとも見え、2 つ目の for (int i …) は同じ変数を使う', ...);
it('sampler の dim を sampler_state の Texture の型、なければ使い方から決める', ...);
it('スワズルの誤り (xr を混ぜる・float2 の .z) は FX-TYPE-SWIZZLE、x.xx = … は FX-TYPE-LVALUE', ...);
it('注釈の値は定数に計算する (string・float2 = {1, 1})', ...);
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/fx/check.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — スコープは配列の積み重ね。式は型を書き足しながら下から上へ。関数の呼び出しはユーザーの関数を先に探し、なければ組み込み関数。誤りを積んでも続けられるよう、型の分からない式には `{ k: 'void' }` を付けてその先の誤りを出さない。
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "FX コンパイラ: 型チェック"`

---

### Task 8: Script と描画ステート

**Files:**
- Create: `src/core/fx/script.ts`, `src/core/fx/states.ts`
- Test: `src/core/fx/script.test.ts`, `src/core/fx/states.test.ts`

**Interfaces:**
- Consumes: `CheckedEffect.constEval`（Task 7）、`StateAssign`（Task 5）
- Produces:

```ts
// script.ts
export type ScriptCmdName = 'RenderColorTarget' | 'RenderDepthStencilTarget' | 'ClearSetColor' | 'ClearSetDepth' | 'ClearSetStencil'
  | 'Clear' | 'ScriptExternal' | 'Pass' | 'LoopByCount' | 'LoopEnd' | 'LoopGetIndex' | 'Draw';
export interface ScriptCommand { cmd: string; index?: number; value: string }   // 知らない命令も cmd にそのまま残す
export function parseScript(text: string, loc: Loc, diags: Diagnostics): ScriptCommand[];
// states.ts
export type StateValue = number | boolean | string | number[] | { expr: string };
export interface RenderState { name: string; index?: number; value: StateValue }
export function normalizeStates(assigns: StateAssign[], kind: 'pass' | 'sampler', checked: CheckedEffect, diags: Diagnostics): RenderState[];
```

ステートの表（名前は大文字小文字を無視して照らし、表の書き方に直す。値の名前は大文字の文字列にする）:
- 真偽: `ZEnable ZWriteEnable AlphaBlendEnable AlphaTestEnable SeparateAlphaBlendEnable StencilEnable TwoSidedStencilMode MultiSampleAntialias SRGBWriteEnable ScissorTestEnable PointSpriteEnable SRGBTexture`（`TRUE`/`FALSE`/数）
- ブレンド `SrcBlend DestBlend SrcBlendAlpha DestBlendAlpha`: `ZERO ONE SRCCOLOR INVSRCCOLOR SRCALPHA INVSRCALPHA DESTALPHA INVDESTALPHA DESTCOLOR INVDESTCOLOR SRCALPHASAT BOTHSRCALPHA BOTHINVSRCALPHA BLENDFACTOR INVBLENDFACTOR`
- `BlendOp BlendOpAlpha`: `ADD SUBTRACT REVSUBTRACT MIN MAX`
- 比較 `ZFunc AlphaFunc StencilFunc CCW_StencilFunc`: `NEVER LESS EQUAL LESSEQUAL GREATER NOTEQUAL GREATEREQUAL ALWAYS`
- `CullMode`: `NONE CW CCW`／`FillMode`: `POINT WIREFRAME SOLID`／`ShadeMode`: `FLAT GOURAUD`
- ステンシルの操作 `StencilPass StencilFail StencilZFail CCW_StencilPass CCW_StencilFail CCW_StencilZFail`: `KEEP ZERO REPLACE INCRSAT DECRSAT INVERT INCR DECR`
- 数: `AlphaRef StencilRef StencilMask StencilWriteMask DepthBias SlopeScaleDepthBias BlendFactor`、`ColorWriteEnable`（index 0〜3。`RED`=1・`GREEN`=2・`BLUE`=4・`ALPHA`=8 を `|` でつないだ式も数にする）
- サンプラー: `MinFilter MagFilter MipFilter`: `NONE POINT LINEAR ANISOTROPIC`／`AddressU AddressV AddressW`: `WRAP MIRROR CLAMP BORDER MIRRORONCE`／`BorderColor`（数か数の並び）・`MaxAnisotropy MaxMipLevel MipMapLodBias`（数）／`Texture`（テクスチャの名前の文字列）
- pass の `VertexShader`・`PixelShader` は `normalizeStates` では読み飛ばす（`entries` が扱う）。表にない名前は `FX-WARN-STATE` で捨てる。値が定数に計算できなければ `{ expr: 元の文 }` にして `FX-WARN-STATE-EXPR`。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('Script を命令の列にする (空の値・空白・最後の ; なし)', () => {
  expect(parseScript('RenderColorTarget0=ScnMap; RenderColorTarget1=;Pass=SSDO; LoopByCount=Count', L, d)).toEqual([
    { cmd: 'RenderColorTarget', index: 0, value: 'ScnMap' }, { cmd: 'RenderColorTarget', index: 1, value: '' },
    { cmd: 'Pass', value: 'SSDO' }, { cmd: 'LoopByCount', value: 'Count' }]);
  expect(parseScript('RenderColorTarget=X;', L, d)[0]).toEqual({ cmd: 'RenderColorTarget', index: 0, value: 'X' });
});
it('知らない命令は FX-WARN-SCRIPT で、命令は残す', ...);
it('描画ステートを表の書き方と値に直す', () => {
  expect(statesOf('alphablendenable = TRUE; SrcBlend = srcalpha; CullMode = NONE; ColorWriteEnable = RED|GREEN|BLUE; ZFunc = LESSEQUAL;')).toEqual([
    { name: 'AlphaBlendEnable', value: true }, { name: 'SrcBlend', value: 'SRCALPHA' }, { name: 'CullMode', value: 'NONE' },
    { name: 'ColorWriteEnable', index: 0, value: 7 }, { name: 'ZFunc', value: 'LESSEQUAL' }]);
});
it('サンプラーステートの Texture は名前、BorderColor は数の並び', ...);
it('知らない名前は FX-WARN-STATE、uniform を使う値は { expr } で FX-WARN-STATE-EXPR', ...);
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/fx/script.test.ts src/core/fx/states.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する** — 表は `states.ts` の中の 1 つのオブジェクトにまとめる。`ColorWriteEnable` の `RED|GREEN…` は、その名前だけを数に置き換えて `constEval` する。
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "FX コンパイラ: Script と描画ステート"`

---

### Task 9: GLSL の書き出し (1) — 型・名前・式・文・関数

**Files:**
- Create: `src/core/fx/emit.ts`
- Modify: `package.json`（devDependencies に `@shaderfrog/glsl-parser`）
- Test: `src/core/fx/emit.test.ts`

**Interfaces:**
- Consumes: `CheckedEffect`, `FunctionInfo`（Task 7）、AST の型チェック済みの欄
- Produces:

```ts
export function glslName(name: string): string;
export function glslType(t: Type): string;          // float→float, float3→vec3, int2→ivec2, bool4→bvec4, float4x3→mat4x3, float4x4→mat4, sampler(2D/1D/null)→sampler2D, 3D→sampler3D, CUBE→samplerCube
export function zeroOf(t: Type): string;            // 'vec3(0.0)'・'S(0.0, vec2(0.0))' など
export interface EmitContext {
  checked: CheckedEffect; stage: 'vertex' | 'fragment';
  helpers: Set<string>;                              // 使った mme_ の関数 (mme_fmod など)
  usedGlobals: Set<string>; usedFunctions: Set<FunctionInfo>; usedStructs: Set<string>;
}
export function emitExpr(e: Expr, ctx: EmitContext): string;
export function emitStmt(s: Stmt, ctx: EmitContext, indent: string): string;
export function emitFunctions(roots: FunctionInfo[], ctx: EmitContext): string;   // 使う関数のプロトタイプをすべて書いてから、中身を書く
export function emitStructs(ctx: EmitContext): string;                           // 使う構造体を、使われる順に
export function emitHelpers(ctx: EmitContext): string;                           // helpers にあるものだけ
```

決まり（設計書 ④ の表と「仕様の補足」4・9・10 に加えて）:
- `glslName`: GLSL ES 3.00 の予約語・予約された名前・組み込み関数の名前（`input output sample filter texture smooth flat layout precision common partition active buffer shared mix mod fract inversesqrt dFdx dFdy texture textureLod …`）か、`/^(a|v|o|mme)_/` に合う名前は後ろに `_`。`gl_` で始まる名前は前に `x`。`_` が 2 つ以上続く所は `_x_` にする。
- 行列: HLSL の `floatRxC` → GLSL の `mat{R}x{C}`（正方なら `mat{N}`）。`mul(a, b)` → `(b) * (a)`（スカラーとの mul は `a * b`、ベクトルどうしは `dot`）。行列 `*` 行列 → `matrixCompMult(a, b)`。`M[i]` はそのまま、`M._m01` → `M[0][1]`、いくつかなら `vec2(M[0][1], M[1][0])`。行列の切り詰め `(float3x3)M` → `mat3(M)`。
- ベクトルの比較 → `lessThan greaterThan lessThanEqual greaterThanEqual equal notEqual`、ベクトルの `!` → `not()`、ベクトルの `&& ||` → 成分ごとの `bvecN(a.x && b.x, …)`、条件がベクトルの三項 → float のときは `mix(else, then, cond)`、それ以外は成分ごと。
- `%` と `/`: float の `%` → `mme_fmod(a, b)`（`a - b * trunc(a / b)`）、int の `/` → `mme_idiv(a, b)`（`int(trunc(float(a) / float(b)))`）、int の `%` → `mme_imod(a, b)`（`a - b * mme_idiv(a, b)`）。複合代入（`%=`・int の `/=`・行列の `*=`）は `x = f(x, y)` に開く。開くと副作用が 2 回になる左辺（`a[i++] %= 2`）は `FX-UNSUPPORTED`。
- 組み込み関数の付け替え: 設計書の表のとおり。加えて `ddy` は「補足 4」、`all`/`any` の float 版 → `any(notEqual(x, vecN(0.0)))`／スカラーは `x != 0.0`、`log10(x)` → `(log(x) * 0.4342944819)`、`ldexp(x, e)` → `(x * exp2(e))`、`isfinite(x)` → `!(isnan(x) || isinf(x))`（ベクトルは成分ごと）、`sincos(x, s, c)` → `mme_sincos`、`lit` → `mme_lit`、`D3DCOLORtoUBYTE4(x)` → `ivec4(x.zyxw * 255.001953)`、`tex1D(s, x)` → `texture(s, vec2(x, 0.5))`、`tex2Dlod(s, t)` → `textureLod(s, t.xy, t.w)`、`tex2Dbias(s, t)` → `texture(s, t.xy, t.w)`、`tex2Dproj(s, t)` → `textureProj(s, t)`、`tex2D(s, t, dx, dy)`・`tex2Dgrad` → `textureGrad`（3D・CUBE も同じ形）。
- 数: float は必ず小数点か指数を付ける（`1.0`・`1e-05`）。無限大は `uintBitsToFloat(0x7F800000u)`。`convert` の中身が数なら、変換したあとの数をそのまま書く。
- for の初期化の変数はループの前で宣言し（`reuses` のあるものは宣言せず代入だけ）、`for (i = 0; …)` にする。

- [ ] **Step 1: 失敗するテストを書く**（`emitFn(src, name)` = 型チェックまで通して、その関数を書き出した文字列）

```ts
it('glslName', () => {
  expect(['input', 'mix', 'color', 'gl_Foo', 'a__b', 'a_POSITION'].map(glslName)).toEqual(['input_', 'mix_', 'color', 'xgl_Foo', 'a_x_b', 'a_POSITION_']);
});
it('glslType', () => expect([F4x3, M44, I2, samplerOf(null)].map(glslType)).toEqual(['mat4x3', 'mat4', 'ivec2', 'sampler2D']));
it('mul と行列の要素', () => {
  expect(exprOf('mul(v, M)', { v: 'float4', M: 'float4x3' })).toBe('(M) * (v)');
  expect(exprOf('mul(M, v)', { v: 'float4', M: 'float3x4' })).toBe('(v) * (M)');
  expect(exprOf('M._m21', { M: 'float3x4' })).toBe('M[2][1]');
  expect(exprOf('A * B', { A: 'float4x4', B: 'float4x4' })).toBe('matrixCompMult(A, B)');
});
it('fmod・int の割り算・ベクトルの比較と選択', () => {
  expect(exprOf('fmod(a, b)', { a: 'float', b: 'float' })).toBe('mme_fmod(a, b)');
  expect(exprOf('i / j', { i: 'int', j: 'int' })).toBe('mme_idiv(i, j)');
  expect(exprOf('(x > 2) ? 10 : 20', { x: 'float3' })).toBe('mix(vec3(20.0), vec3(10.0), greaterThan(x, vec3(2.0)))');
});
it('スカラーのスワズル・暗黙の変換の数はたたむ', () => {
  expect(exprOf('s.xx', { s: 'float' })).toBe('vec2(s)');
  expect(exprOf('t = 1', { t: 'float3' })).toBe('t = vec3(1.0)');
});
it('for の変数を前に出し、2 つ目の for は使い直す', ...);
it('書き出した関数は GLSL ES 3.00 として読める', () => {
  // 補足 9 の 0 初期化・プロトタイプ・helpers を含む関数一式を @shaderfrog/glsl-parser の parser.parse に通して例外が出ない
});
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/fx/emit.test.ts` / Expected: FAIL
- [ ] **Step 3: `npm install -D @shaderfrog/glsl-parser` して実装する**
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git add package.json package-lock.json src/core/fx && git commit -m "FX コンパイラ: GLSL の書き出し (式・文・関数)"`

---

### Task 10: GLSL の書き出し (2) — pass ごとの main・入出力・uniform の一覧

**Files:**
- Create: `src/core/fx/desc.ts`, `src/core/fx/entry.ts`
- Test: `src/core/fx/entry.test.ts`

**Interfaces:**
- Consumes: `emit.ts`（Task 9）、`CheckedEffect`, `EntryInfo`（Task 7）
- Produces:

```ts
// desc.ts (出力の型。すべて JSON にできる)
export interface Annotation { name: string; type: string; value: number[] | string }
export interface UniformRef { name: string; glslName: string; type: string; kind: 'value' | 'sampler' | 'builtin'; stages: ('vertex' | 'fragment')[] }
export interface AttributeRef { semantic: string; glslName: string; type: 'float4' }
export interface Program { vertex: string; fragment: string; uniforms: UniformRef[]; attributes: AttributeRef[]; outputs: number; uniformVectors: number }
export interface Param { name: string; glslName: string; type: string; semantic: string | null; storage: 'uniform' | 'static' | 'const';
                         annotations: Annotation[]; init: number[] | string | null }
export interface TextureDecl { name: string; type: string; semantic: string | null; annotations: Annotation[] }
export interface SamplerDecl { name: string; glslName: string; dim: Dim; texture: string | null; states: RenderState[] }
export interface Pass { name: string; annotations: Annotation[]; script: ScriptCommand[]; states: RenderState[]; program: Program | null }
export interface Technique { name: string; annotations: Annotation[]; script: ScriptCommand[]; passes: Pass[] }
export interface EffectDesc { params: Param[]; textures: TextureDecl[]; samplers: SamplerDecl[]; techniques: Technique[] }
// entry.ts
export function normalizeSemantic(s: string): string;   // 大文字にし、TEXCOORD・COLOR・BLENDWEIGHT・BLENDINDICES に番号がなければ 0 を付け、POSITION0・NORMAL0 などの 0 は取る
export function emitProgram(checked: CheckedEffect, pass: PassNode, diags: Diagnostics): Program | null;   // vs も ps もなければ null。片方だけなら FX-UNSUPPORTED
```

決まり（設計書 ④ の表と「仕様の補足」5〜7 に加えて）:
- 頂点の `main`: `mme_init()`（`needsInit` の static を宣言の順に計算する。使うものがあるときだけ）→ 入口の関数を呼ぶ（`in` は `a_<SEM>` を引数の型に切り詰めたもの、構造体なら各メンバーから作る。`out` は 0 で初期化した局所変数。`uniform` は `uniformArgs` を書き出した式）→ `POSITION` の出力は `gl_Position = vec4(p.x, p.y * mme_flipY, 2.0 * p.z - p.w, p.w);`、`PSIZE` → `gl_PointSize`、ほかは `v_<SEM>` へ (0, 0, 0, 1) で埋めて書く。
- フラグメントの `main`: 入力は `v_<SEM>` を切り詰めたもの。`VFACE`・`VPOS`（補足 5）・`POSITION`（頂点からは来ないので `vec4(0.0)`。**実際に読んでいるときだけ** `FX-WARN-SEMANTIC`）。頂点が出していないセマンティクスは `vec4(0.0)` にして `FX-WARN-SEMANTIC`。出力は `COLORn` → `layout(location = n) out vec4 o_COLORn;`（float などは (x, 0, 0, 1) に埋める）、`DEPTH` → `gl_FragDepth`。
- セマンティクスのない `in`/`out` の引数（`uniform` 以外）・頂点が `POSITION` を出さない → `FX-PASS-SEMANTIC`。
- `uniforms`: 2 つのシェーダーで使うグローバル変数（static と GLSL の const は除く）とサンプラーを、宣言の順に、使う段階（`stages`）付きで。`mme_flipY`（kind 'builtin'、type 'float'、頂点ではいつも使う。`ddy`・`VPOS` を使えばフラグメントにも）と `mme_viewport`（'builtin'、'float2'。`VPOS` を使うときだけ）を最後に足す。
- `uniformVectors`: 値の uniform（builtin も）について、スカラーとベクトルは 1、`floatRxC` は R、配列は長さを掛ける。同じ uniform は 1 回だけ数える。
- `outputs`: いちばん大きい `COLORn` の n + 1（`COLOR` がなければ 0）。
- 先頭は Global Constraints の 6 行。続けて構造体 → uniform・in・out の宣言 → GLSL の const と static のグローバル変数 → helpers → 関数 → `mme_init` → `main`。

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('MMD の標準のような pass', () => {
  const p = programOf(`float4x4 WVP : WORLDVIEWPROJECTION; texture T; sampler S = sampler_state { texture = <T>; };
    struct VO { float4 Pos : POSITION; float2 Tex : TEXCOORD0; };
    VO VS(float4 Pos : POSITION, float2 Tex : TEXCOORD0) { VO o; o.Pos = mul(Pos, WVP); o.Tex = Tex; return o; }
    float4 PS(VO IN) : COLOR0 { return tex2D(S, IN.Tex); }
    technique T0 { pass P0 { VertexShader = compile vs_3_0 VS(); PixelShader = compile ps_3_0 PS(); } }`);
  expect(p.attributes).toEqual([{ semantic: 'POSITION', glslName: 'a_POSITION', type: 'float4' }, { semantic: 'TEXCOORD0', glslName: 'a_TEXCOORD0', type: 'float4' }]);
  expect(p.uniforms.map(u => [u.name, u.kind, u.stages])).toEqual([['WVP', 'value', ['vertex']], ['S', 'sampler', ['fragment']], ['mme_flipY', 'builtin', ['vertex']]]);
  expect(p).toMatchObject({ outputs: 1, uniformVectors: 5 });
  expect(p.vertex).toContain('gl_Position = vec4(');
  expect(p.vertex.split('\n').slice(0, 6)).toEqual(HEADER);
});
it('同じ構造体を頂点とフラグメントで使う (POSITION を読まなければ警告なし、読めば FX-WARN-SEMANTIC)', ...);
it('予約語の名前の uniform と局所変数', () => {
  // float4 input; float4 PS() : COLOR0 { float4 sample = input; return sample; } → uniforms の glslName が 'input_'、fragment に 'vec4 sample_'
});
it('MRT と DEPTH', ...);                         // COLOR0〜2 と DEPTH → outputs 3、gl_FragDepth
it('VPOS を使うと mme_viewport が入り、ddy を使うとフラグメントにも mme_flipY', ...);
it('pass の uniform の引数を main に埋め込む', ...);
it('static の初期値を mme_init で計算する', ...);
it('頂点が出していない TEXCOORD3 を読むと vec4(0.0) と FX-WARN-SEMANTIC', ...);
it('頂点が POSITION を出さない・セマンティクスのない in は FX-PASS-SEMANTIC', ...);
it('書き出した頂点とフラグメントは GLSL ES 3.00 として読める', ...);   // @shaderfrog/glsl-parser
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/fx/entry.test.ts` / Expected: FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 通ることを確かめる** — 同じコマンド / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "FX コンパイラ: pass ごとのシェーダー"`

---

### Task 11: compileEffect

**Files:**
- Create: `src/core/fx/index.ts`, `src/core/fx/fixtures/basic.fx`, `post.fx`, `mrt.fx`, `include.fx`, `inc/Common.fxsub`
- Test: `src/core/fx/index.test.ts`

**Interfaces:**
- Consumes: Task 1〜10 のすべて
- Produces:

```ts
export type { EffectDesc, Param, TextureDecl, SamplerDecl, Technique, Pass, Program, UniformRef, AttributeRef, Annotation } from './desc.ts';
export type { Diagnostic, DiagCode } from './diagnostics.ts';
export type EffectResult =
  | { ok: true; effect: EffectDesc; warnings: Diagnostic[] }
  | { ok: false; errors: Diagnostic[]; warnings: Diagnostic[] };
export function compileEffect(entry: string, readFile: (path: string) => Uint8Array | null,
                              options?: { defines?: Record<string, string>; listFiles?: () => string[] }): EffectResult;
```

組み立て方:
- `params`: テクスチャとサンプラー以外のグローバル変数を宣言の順に。`type` は `typeName`、`semantic` は大文字にしただけ（番号は直さない）、`init` は `GlobalInfo.value` の並び（文字列なら文字列、なければ null）。
- `textures`: テクスチャの型のグローバル変数（`type` は書かれた型の名前 `texture`・`texture2D`・`texture3D`・`textureCUBE`）。
- `samplers`: サンプラーの型のグローバル変数。`dim` は決まった dim（使われていなければ '2D'）、`texture` は `Texture` ステートの名前、`states` は `normalizeStates(…, 'sampler', …)` から `Texture` を除いたもの。
- `techniques`: 注釈（`Script` も注釈に残す）、`script` は `Script` の注釈を `parseScript` したもの（なければ []）、pass ごとに注釈・script・`normalizeStates(…, 'pass', …)`・`emitProgram`。
- 誤りがあれば（`FxError` が投げられた・`errors` が空でない）`ok: false`。それ以外の例外は「補足 11」の `FX-INTERNAL`。

- [ ] **Step 1: 失敗するテストを書く**（見本は `import.meta.glob('./fixtures/**/*', { query: '?raw', import: 'default', eager: true })` で読み、`TextEncoder` でバイト列にする）

```ts
it('MMD の標準のようなエフェクト (basic.fx)', () => {
  const r = compileFixture('basic.fx');
  expect(r.ok).toBe(true);
  // params に WorldViewProjMatrix (semantic 'WORLDVIEWPROJECTION', type 'float4x4')、
  // techniques[0].annotations に { name: 'MMDPass', type: 'string', value: 'object' }、passes[0].program が null でない
});
it('ポストエフェクト (post.fx): STANDARDSGLOBAL・RENDERCOLORTARGET の注釈・Script・pass の引数', () => {
  // params に { name: 'Script', semantic: 'STANDARDSGLOBAL', init: [0.8] }、textures に RENDERCOLORTARGET の T (annotations に Format の文字列)、
  // techniques[0].script が [RenderColorTarget0=ScnMap, … , ScriptExternal=Color, … Pass=Blur]、passes[0].states に ZEnable false
});
it('Shift-JIS の注釈', () => {
  const r = compileEffect('a.fx', readerOf({ 'a.fx': encodeShiftJis('float b < string UIName = "明るさ"; > = 1;' + MINIMAL_TECHNIQUE) }));
  expect(r.ok && r.effect.params[0].annotations[0]).toEqual({ name: 'UIName', type: 'string', value: '明るさ' });
});
it('include.fx の #include "inc\\common.FXSUB" を listFiles で見つける', ...);
it('誤りがあれば ok: false で、errors の code と場所', () => {
  const r = compileEffect('a.fx', readerOf({ 'a.fx': 'float4 PS() : COLOR0 { return nope; }' + PS_TECHNIQUE }));
  expect(r).toMatchObject({ ok: false, errors: [{ code: 'FX-TYPE-UNDEFINED', file: 'a.fx', line: 1 }] });
});
it('例外を外に出さない (FX-INTERNAL)', ...);   // readFile が例外を投げる
it('結果は JSON にしても同じ', () => { const r = compileFixture('post.fx'); expect(JSON.parse(JSON.stringify(r))).toEqual(r); });
```

- [ ] **Step 2: 落ちることを確かめる** — Run: `npx vitest run src/core/fx/index.test.ts` / Expected: FAIL
- [ ] **Step 3: 見本の .fx を書き、`compileEffect` を実装する** — `basic.fx` は MMD の標準のシェーダー（`WORLDVIEWPROJECTION`・`MATERIALDIFFUSE`・テクスチャとサンプラー・`MMDPass = "object"` と `"object_ss"`）に近いもの、`post.fx` はポストエフェクト（`STANDARDSGLOBAL`・`RENDERCOLORTARGET`・`RENDERDEPTHSTENCILTARGET`・`ScriptExternal=Color`・`LoopByCount`・`uniform` の引数のある 2 つの pass）、`mrt.fx` は COLOR0〜2 の出力。
- [ ] **Step 4: 通ることを確かめる** — Run: `npx vitest run src/core/fx` / Expected: PASS
- [ ] **Step 5: コミット** — `git commit -m "FX コンパイラ: compileEffect と見本の .fx"`

---

### Task 12: Ray-MMD 1.5.2 を全部通す

**Files:**
- Create: `third_party/ray-mmd-1.5.2/**`（.fx・.fxsub・.conf と `LICENSE.txt`）、`third_party/ray-mmd-1.5.2/README.md`、`src/core/fx/testing/rayCorpus.ts`、`src/core/fx/corpus.test.ts`
- Modify: 見つかった不具合の持ち主のファイル（と、そのテスト）

**Interfaces:**
- Consumes: `compileEffect`（Task 11）
- Produces:

```ts
// testing/rayCorpus.ts
export interface Corpus { files: Record<string, Uint8Array>; readFile(path: string): Uint8Array | null; listFiles(): string[] }
export function corpusFrom(files: Record<string, string>): Corpus;          // 文字列 (どれも ASCII) をバイト列にする
export function rayConfVariants(conf: string): { name: string; conf: string }[];
// ray.conf の各 #define の直前に続く「// N : …」の行の N を値の一覧とし、1 つの #define だけをその値に変えたものを全部返す
// (いまの値と同じものは除く)。name は 'AA_QUALITY=3' の形
```

- [ ] **Step 1: ユーザーに確認してから取ってくる** — 「GitHub の ray-cast/ray-mmd、タグ 1.5.2（コミット `a425ab6d4219a047f8d64ac7fdc4f73c76c31dc8`）から、.fx・.fxsub・.conf の 628 個（約 2 MB）と LICENSE.txt を取ってきて `third_party/ray-mmd-1.5.2/` に置いてよいか」を聞き、はいなら、`gh api 'repos/ray-cast/ray-mmd/git/trees/1.5.2?recursive=1'` の一覧から拡張子で選んだファイルを `https://raw.githubusercontent.com/ray-cast/ray-mmd/1.5.2/<パス>` から取ってくる（フォルダの形はそのまま。改行コードも変えない）。`README.md` に、元の場所・タグ・コミット・入れた拡張子・数・「MIT ライセンス（LICENSE.txt）」を書く。
- [ ] **Step 2: 全部を変換するテストを書く**

```ts
// corpus.test.ts
const raw = import.meta.glob('../../../third_party/ray-mmd-1.5.2/**/*.{fx,fxsub,conf}', { query: '?raw', import: 'default', eager: true });
const corpus = corpusFrom(stripPrefix(raw));
const entries = corpus.listFiles().filter(p => p.endsWith('.fx'));
it('Ray-MMD の .fx が 515 個ある (.fxsub 107 個・.conf 6 個も)', () => expect(entries.length).toBe(515));
for (const e of entries) it(`${e} をエラー 0 で変換する`, () => expectOk(compileEffect(e, corpus.readFile, { listFiles: corpus.listFiles })));
for (const v of rayConfVariants(text(corpus.readFile('ray.conf')!))) {
  it(`ray.fx (${v.name})`, () => expectOk(compileEffect('ray.fx', p => p === 'ray.conf' ? utf8(v.conf) : corpus.readFile(p), { listFiles: corpus.listFiles })));
}
it('rayConfVariants', () => {
  expect(rayConfVariants('// 0 : None\n// 1 : FXAA\n// 2 : SMAA\n#define AA_QUALITY 1\n').map(v => v.name)).toEqual(['AA_QUALITY=0', 'AA_QUALITY=2']);
});
// expectOk は、失敗なら errors の先頭 5 つを「code file:line:column message」で並べて落とす
```

- [ ] **Step 3: 動かして、失敗を数える** — Run: `npx vitest run src/core/fx/corpus.test.ts` / Expected: はじめは FAIL。失敗を code ごとに数える。
- [ ] **Step 4: 原因ごとに直す（くり返す）** — 原因 1 つごとに、その原因を表す最小の HLSL を持ち主のタスクのテストファイルに足し（落ちることを確かめる）、直し、`npx vitest run src/core/fx` を通してからコミットする（`git commit -m "FX コンパイラ: <直したこと>"`）。`FX-UNSUPPORTED` が出たら、その機能を足すか、Ray-MMD に要らないことを確かめたうえでユーザーに相談する（勝手に未対応のまま通さない）。
- [ ] **Step 5: 全部通ることを確かめる** — Run: `npx vitest run src/core/fx` / Expected: PASS（Ray-MMD のすべての .fx と、ray.conf の切り替えのすべてで errors が 0）
- [ ] **Step 6: コミット** — `git add third_party src/core/fx && git commit -m "Ray-MMD 1.5.2 の .fx を見本に入れ、全部変換できるようにする"`

---

### Task 13: 本物の WebGL2 でリンクと値を確かめる

**Files:**
- Create: `e2e/fx-webgl.spec.ts`, `e2e/fx-harness.ts`
- Modify: 見つかった不具合の持ち主のファイル（と、その単体テスト）

**Interfaces:**
- Consumes: `compileEffect`（Task 11）、`corpusFrom`・`rayConfVariants`（Task 12）
- Produces（`e2e/fx-harness.ts`。e2e の中だけで使う）:

```ts
// ページの中で: WebGL2 の文脈を作り、シェーダーをコンパイル・リンクして、失敗したものを返す
export async function linkAll(page: Page, programs: { name: string; vertex: string; fragment: string }[]): Promise<{ name: string; log: string }[]>;
// HLSL を 1 つ変換して、1x1 の RGBA32F (EXT_color_buffer_float) に全面の三角形で描き、出力ごとの値を読む。uniforms は名前 → 数の並び
export async function runPixel(page: Page, hlsl: string, uniforms?: Record<string, number[]>): Promise<number[][]>;
```

- [ ] **Step 1: リンクのテストを書く** — Node 側で Ray-MMD の全 .fx と ray.conf の切り替えを変換し、`program` を `vertex + '\0' + fragment` で重なりを除いてから 150 個ずつのテストに分け、`linkAll` が `[]` を返すことを確かめる（`page.goto('about:blank')`。1 つのテストの時間は `test.setTimeout(180_000)`）。
- [ ] **Step 2: 値のテストを書く**（`runPixel` の値は、HLSL の仕様から手で計算したもの）

```ts
const cases: [string, string, number[][]][] = [
  ['mul(v, M) の 4x3', 'float4x3 M = float4x3(1,2,3, 4,5,6, 7,8,9, 10,11,12); return float4(mul(float4(1,0,2,1), M), 0);', [[25, 29, 33, 0]]],
  ['mul(M, v) の 3x4', 'float3x4 N = float3x4(1,2,3,4, 5,6,7,8, 9,10,11,12); return float4(mul(N, float4(1,1,0,2)), 0);', [[11, 27, 43, 0]]],
  ['行列の行と要素', 'float3x4 N = float3x4(1,2,3,4, 5,6,7,8, 9,10,11,12); return float4(N[1].w, N._m21, N._14, 0);', [[8, 10, 4, 0]]],
  ['fmod', 'return float4(fmod(5.5, 2), fmod(-5.5, 2), fmod(5.5, -2), 0);', [[1.5, -1.5, 1.5, 0]]],
  ['int の割り算と剰余', 'int a = -7; int b = 2; return float4(a / b, a % b, 7 / 2, 7 % -2);', [[-3, -1, 3, 1]]],
  ['スワズルへの代入', 'float4 c = 0; c.zx = float2(1, 2); float s = 3; c.yw = s.xx; return c;', [[2, 3, 1, 3]]],
  ['暗黙の切り詰めと広げ', 'float3 t = float4(1,2,3,4); float4 u = 0.5; return float4(t.z, u.y, dot(t, 1), 0);', [[3, 0.5, 6, 0]]],
  ['ベクトルの比較と選択', 'float3 x = float3(1,5,3); float3 r = (x > 2) ? 10 : 20; return float4(r, all(x) && !any(float3(0,0,0)) ? 1 : 0);', [[20, 10, 10, 1]]],
  ['for の変数はループのあとも見える', 'for (int j = 0; j < 3; j++) {} return float4(j, 0, 0, 0);', [[3, 0, 0, 0]]],
];
// runPixel は 'float4 PS() : COLOR0 { <本文> }' と、全面の三角形の VS と technique を足して変換する
test('static の初期値を uniform から計算する', async ({ page }) => {
  // 'float k; static float k2 = k * 2 + 1;' で k = [3] → [[7, 0, 0, 0]]
});
test('pass の uniform の引数', ...);   // PS(uniform float2 off) と compile ps_3_0 PS(float2(0.25, 0.5)) → [[0.25, 0.5, 0.75, 1]]
test('MRT', ...);                      // COLOR0〜2 = (1,0,0,1)・(0,1,0,1)・(0,0,1,1) → 3 つの値
```

- [ ] **Step 3: 動かして確かめる** — Run: `npx playwright test e2e/fx-webgl.spec.ts` / Expected: 落ちたものがあれば、Task 12 の Step 4 と同じやり方（持ち主のタスクのテストに足して直す）で直す。
- [ ] **Step 4: 通ることを確かめる** — Run: `npx playwright test e2e/fx-webgl.spec.ts` と `E2E_GL=software npx playwright test e2e/fx-webgl.spec.ts`（CI と同じソフトウェア描画） / Expected: どちらも PASS
- [ ] **Step 5: コミット** — `git add e2e src/core/fx && git commit -m "FX コンパイラ: WebGL2 でリンクと値を確かめる e2e"`

---

### Task 14: fx:check・fx/ フォルダ・文書

**Files:**
- Create: `scripts/fx-check.ts`, `fx/README.md`
- Modify: `.gitignore`, `package.json`（scripts）, `ARCHITECTURE.md`, `README.md`

**Interfaces:**
- Consumes: `compileEffect`（Task 11）

`scripts/fx-check.ts` の動き（`node scripts/fx-check.ts [フォルダ…]`。引数がなければ `fx/` と `third_party/ray-mmd-1.5.2/`）:
- ルート: `third_party/ray-mmd-1.5.2/` はそのフォルダ。`fx/` は、直下のフォルダ 1 つずつ（エフェクトの一式ごと）をルートにし、`fx/` の直下のファイルは `fx/` をルートにする。
- ルートの中の .fx を名前の順にすべて変換し、1 行ずつ「ファイル・結果（`成功` か、最初の errors の code）・場所（`file:line`）・時間（ms、小数 1 桁）」を表にして出す。最後に、成功の数と、code ごとの数と、いちばん遅かったファイルと時間を出す。
- 終了コードはいつも 0（報告のための道具なので）。`fx/` がなければその旨を 1 行出して飛ばす。

- [ ] **Step 1: スクリプトを書いて動かす** — Run: `npm run fx:check` / Expected: Ray-MMD の全 .fx が `成功`、最後の行に成功の数と時間。いちばん遅いものが 200 ms を超えていたら、その数字を記録してユーザーに伝える（テストにはしない）。
- [ ] **Step 2: `fx/README.md` と `.gitignore`** — `.gitignore` に `/fx/*` と `!/fx/README.md` を足す。`fx/README.md` は `models/README.md` と同じ調子で「手持ちの MME のエフェクトを置く場所・Git に入らない・規約で再配布できないものがあるので公開しない・`npm run fx:check` で変換できるか確かめられる」を書く。
- [ ] **Step 3: `package.json` に `"fx:check": "node scripts/fx-check.ts"` を足す**
- [ ] **Step 4: 文書を書き足す** — `ARCHITECTURE.md` の core の説明に「MME の .fx のコンパイラ（`core/fx/`。前処理 → 構文解析 → 型チェック → GLSL ES 3.00 の書き出し、`compileEffect` が入口）」を足す。`README.md` の「効果（MME 風）」の節の終わりに「MME 互換モード（作っている途中）」の小節を作り、いまはコンパイラだけがあること・`fx/` フォルダ・`npm run fx:check`・Ray-MMD 1.5.2 を見本に入れていること（MIT）を書く。README のフォルダの一覧（`render/ …` の行の近く）に `core/fx/` と `third_party/` を足す。
- [ ] **Step 5: 全体を確かめる** — Run: `npm run test:all` / Expected: 「すべて成功」
- [ ] **Step 6: コミット** — `git add scripts/fx-check.ts fx/README.md .gitignore package.json ARCHITECTURE.md README.md && git commit -m "fx:check と fx/ フォルダ、MME 互換モードのコンパイラの説明"`
