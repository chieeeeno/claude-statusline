"use strict";

/**
 * bin/claude-statusline.js のテスト（Node 組み込みの node:test で実行）。
 *
 * このパッケージは利用者の ~/.claude/settings.json を書き換えるため、
 * 全テストが mkdtemp で作った HOME の中だけで完結する。実 ~/.claude には触れない。
 *
 * package.json に "type": "module" がないので CommonJS で書く。
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "bin", "claude-statusline.js");
const SCRIPT = path.join(ROOT, "statusline.py");
const PKG = require(path.join(ROOT, "package.json"));

// 解決ロジックはサブプロセス越しには通せない分岐を持つため直接読み込む
const cli = require(BIN);

/** 使い捨ての HOME を作り、テスト終了時に消す。 */
function makeHome(t, settings) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-statusline-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(settingsPath(home), settings);
  }
  return home;
}

function settingsPath(home) {
  return path.join(home, ".claude", "settings.json");
}

function readSettings(home) {
  return JSON.parse(fs.readFileSync(settingsPath(home), "utf8"));
}

function run(args, home, input) {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    input,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** 指定した 2 行を印字するだけの偽 python を作る。 */
function makeStub(t, version, executable) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-statusline-stub-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stub = path.join(dir, "python3");
  fs.writeFileSync(stub, `#!/bin/sh\necho '${version}'\necho '${executable}'\n`, { mode: 0o755 });
  return stub;
}

/** テスト環境の本物の python3 の絶対パス。 */
const REAL_PYTHON = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], {
  encoding: "utf8",
}).stdout.trim();

// --- --install ---------------------------------------------------------

test("--install は statusLine を書き、無関係なキーを残す", (t) => {
  const home = makeHome(t, JSON.stringify({ permissions: { allow: ["Bash"] }, env: { FOO: "1" } }));
  const r = run(["--install"], home);
  assert.equal(r.code, 0);
  const settings = readSettings(home);
  assert.deepEqual(settings.permissions, { allow: ["Bash"] });
  assert.deepEqual(settings.env, { FOO: "1" });
  assert.equal(settings.statusLine.type, "command");
  assert.equal(settings.statusLine.refreshInterval, 60);
  assert.match(settings.statusLine.command, /statusline\.py/);
});

test("--install は冪等", (t) => {
  const home = makeHome(t);
  run(["--install"], home);
  const first = fs.readFileSync(settingsPath(home), "utf8");
  run(["--install"], home);
  assert.equal(fs.readFileSync(settingsPath(home), "utf8"), first);
});

test("--install はパスを引用符で包む", (t) => {
  const home = makeHome(t);
  run(["--install"], home);
  assert.match(readSettings(home).statusLine.command, /^'[^']+' '[^']+'$/);
});

test("--runcat は環境変数の前置きを足す", (t) => {
  const home = makeHome(t);
  run(["--install", "--runcat"], home);
  assert.match(readSettings(home).statusLine.command, /^CLAUDE_STATUSLINE_RUNCAT=1 '/);
});

test("--runcat なしでは環境変数を書かない", (t) => {
  const home = makeHome(t);
  run(["--install"], home);
  assert.doesNotMatch(readSettings(home).statusLine.command, /CLAUDE_STATUSLINE_RUNCAT/);
});

// --- パーミッション ----------------------------------------------------

test("新規の settings.json は 0600、.claude は 0700 で作る", (t) => {
  const home = makeHome(t);
  run(["--install"], home);
  assert.equal(fs.statSync(path.join(home, ".claude")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(settingsPath(home)).mode & 0o777, 0o600);
});

test("既存 settings.json のモードは変えない", (t) => {
  const home = makeHome(t, "{}");
  fs.chmodSync(settingsPath(home), 0o644);
  run(["--install"], home);
  assert.equal(fs.statSync(settingsPath(home)).mode & 0o777, 0o644);
});

// --- バックアップ ------------------------------------------------------

test("既存ファイルがあればタイムスタンプ付きで退避する", (t) => {
  const home = makeHome(t, '{"env":{"FOO":"1"}}');
  const r = run(["--install"], home);
  const backups = fs.readdirSync(path.join(home, ".claude")).filter((f) => f.includes(".bak-"));
  assert.equal(backups.length, 1);
  assert.match(r.stdout, /Backed up existing settings/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(home, ".claude", backups[0]), "utf8")),
    { env: { FOO: "1" } }
  );
});

// --- 壊れた settings.json ----------------------------------------------

for (const [label, raw] of [["配列", "[1,2,3]"], ["null", "null"], ["文字列", '"hello"'], ["数値", "42"]]) {
  test(`settings.json が ${label} なら exit 1 で止まる`, (t) => {
    const home = makeHome(t, raw);
    const r = run(["--install"], home);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is not a JSON object/);
    // 未捕捉例外のスタックトレースを利用者に見せない
    assert.doesNotMatch(r.stderr, /^\s+at /m);
    assert.equal(fs.readFileSync(settingsPath(home), "utf8"), raw);
  });
}

test("settings.json が構文エラーなら上書きせず exit 1", (t) => {
  const home = makeHome(t, "{oops");
  const r = run(["--install"], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is not valid JSON/);
  assert.equal(fs.readFileSync(settingsPath(home), "utf8"), "{oops");
});

test("空ファイルは新規扱いで通す", (t) => {
  const home = makeHome(t, "  \n");
  assert.equal(run(["--install"], home).code, 0);
  assert.ok(readSettings(home).statusLine);
});

// --- --uninstall -------------------------------------------------------

test("--uninstall は自分の statusLine だけ消す", (t) => {
  const home = makeHome(t, JSON.stringify({ env: { FOO: "1" } }));
  run(["--install"], home);
  const r = run(["--uninstall"], home);
  assert.equal(r.code, 0);
  const settings = readSettings(home);
  assert.equal(settings.statusLine, undefined);
  assert.deepEqual(settings.env, { FOO: "1" });
});

test("--uninstall は他ツールの statusLine を残す", (t) => {
  const foreign = { type: "command", command: "/usr/local/bin/other-statusline" };
  const home = makeHome(t, JSON.stringify({ statusLine: foreign }));
  const r = run(["--uninstall"], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /points at a different program|different program/);
  assert.deepEqual(readSettings(home).statusLine, foreign);
});

test("--uninstall は statusLine がなければ何もしない", (t) => {
  const home = makeHome(t, "{}");
  const r = run(["--uninstall"], home);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /nothing to uninstall/);
});

// --- フラグの扱い ------------------------------------------------------

test("未知のフラグは exit 1", (t) => {
  const home = makeHome(t);
  const r = run(["--instal"], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown option: --instal/);
});

test("--version はパッケージのバージョンを出す", (t) => {
  const home = makeHome(t);
  const r = run(["--version"], home);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), PKG.version);
});

test("引数なしでは使い方を出して settings.json を作らない", (t) => {
  const home = makeHome(t);
  const r = run([], home);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--install/);
  assert.equal(fs.existsSync(settingsPath(home)), false);
});

// --- --print -----------------------------------------------------------

test("--print は stdin のペイロードを描画する", (t) => {
  const home = makeHome(t);
  const r = run(["--print"], home, '{"model":{"display_name":"Opus 5"},"cwd":"/tmp/demo"}');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Opus 5/);
});

// --- --python ----------------------------------------------------------

test("--python は指定したインタプリタを settings.json に焼く", (t) => {
  const home = makeHome(t);
  const r = run(["--install", "--python", REAL_PYTHON], home);
  assert.equal(r.code, 0);
  assert.equal(readSettings(home).statusLine.command, `'${REAL_PYTHON}' '${SCRIPT}'`);
});

test("--python=<path> の形式も受ける", (t) => {
  const home = makeHome(t);
  assert.equal(run(["--install", `--python=${REAL_PYTHON}`], home).code, 0);
  assert.match(readSettings(home).statusLine.command, new RegExp(REAL_PYTHON));
});

test("--python に値がなければ exit 1", (t) => {
  const home = makeHome(t);
  const r = run(["--install", "--python"], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /requires a path/);
});

test("--python の値が別のフラグなら exit 1", (t) => {
  const home = makeHome(t);
  assert.equal(run(["--install", "--python", "--runcat"], home).code, 1);
});

test("--python の値は未知フラグ扱いしない", (t) => {
  const home = makeHome(t);
  const r = run(["--install", "--python", REAL_PYTHON], home);
  assert.doesNotMatch(r.stderr, /unknown option/);
});

test("--python の指す先が実行できなければ exit 1", (t) => {
  const home = makeHome(t);
  const r = run(["--install", "--python", "/nope/python3"], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not be run as a Python interpreter/);
  assert.equal(fs.existsSync(settingsPath(home)), false);
});

test("--python が版数を名乗れないなら exit 1", (t) => {
  const home = makeHome(t);
  const stub = makeStub(t, "not-a-version", "/bin/sh");
  const r = run(["--install", "--python", stub], home);
  assert.equal(r.code, 1);
  assert.equal(fs.existsSync(settingsPath(home)), false);
});

test("--python が 3.8 未満なら exit 1", (t) => {
  const home = makeHome(t);
  const stub = makeStub(t, "3.7", REAL_PYTHON);
  const r = run(["--install", "--python", stub], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /3\.8 or newer is required/);
});

test("--python では被検査プログラムが名乗った実体パスを採用しない", (t) => {
  // 2 行目に印字した任意の文字列がインタプリタとして焼かれる経路を塞ぐ
  const home = makeHome(t);
  const stub = makeStub(t, "3.12", "/bin/sh");
  run(["--install", "--python", stub], home);
  const command = readSettings(home).statusLine.command;
  assert.match(command, new RegExp(stub));
  assert.doesNotMatch(command, /\/bin\/sh/);
});

// --- インタプリタ解決の単体テスト --------------------------------------
// /usr/bin/python3 が在る環境では PATH 由来の候補まで到達しないため、
// resolvePython() をそのまま呼んでもこの分岐は踏めない。部品を直に叩く。

test("inspectPython は版数を解析できなければ null", (t) => {
  assert.equal(cli.inspectPython(makeStub(t, "not-a-version", "/bin/sh")), null);
  assert.equal(cli.inspectPython(makeStub(t, "3", "/bin/sh")), null);
  assert.equal(cli.inspectPython(makeStub(t, "3.x", "/bin/sh")), null);
  assert.equal(cli.inspectPython("/nope/python3"), null);
});

test("inspectPython は本物の python3 から版数と実体パスを取る", () => {
  const info = cli.inspectPython(REAL_PYTHON);
  assert.ok(Number.isInteger(info.major) && Number.isInteger(info.minor));
  assert.equal(info.executable, REAL_PYTHON);
});

test("meetsMinimum は 3.8 を境に切り替わる", () => {
  assert.equal(cli.meetsMinimum(null), false);
  assert.equal(cli.meetsMinimum({ major: 2, minor: 7 }), false);
  assert.equal(cli.meetsMinimum({ major: 3, minor: 7 }), false);
  assert.equal(cli.meetsMinimum({ major: 3, minor: 8 }), true);
  assert.equal(cli.meetsMinimum({ major: 4, minor: 0 }), true);
});

test("verifiedExecutable は名乗られたパスを検証する", () => {
  // 相対パス、python として動かないもの、版数が食い違うものは全部弾く
  assert.equal(cli.verifiedExecutable({ major: 3, minor: 12, executable: "" }), null);
  assert.equal(cli.verifiedExecutable({ major: 3, minor: 12, executable: "python3" }), null);
  assert.equal(cli.verifiedExecutable({ major: 3, minor: 12, executable: "/bin/sh" }), null);
  assert.equal(cli.verifiedExecutable({ major: 9, minor: 9, executable: REAL_PYTHON }), null);

  const info = cli.inspectPython(REAL_PYTHON);
  assert.equal(cli.verifiedExecutable(info), REAL_PYTHON);
});

test("parseArgs は --python の値をフラグから切り離す", () => {
  const parsed = cli.parseArgs(["--install", "--python", "/opt/python3", "--runcat"]);
  assert.deepEqual([...parsed.flags], ["--install", "--runcat"]);
  assert.equal(parsed.python, "/opt/python3");
  assert.deepEqual(parsed.unknown, []);

  const eq = cli.parseArgs(["--install", "--python=/opt/python3"]);
  assert.equal(eq.python, "/opt/python3");
  assert.deepEqual(eq.unknown, []);

  assert.deepEqual(cli.parseArgs(["--nope"]).unknown, ["--nope"]);
});
