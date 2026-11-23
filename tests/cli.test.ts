"use strict";

/**
 * bin/claude-statusline.js のテスト（Node 組み込みの node:test で実行）。
 *
 * このパッケージは利用者の ~/.claude/settings.json を書き換えるため、
 * 全テストが mkdtemp で作った HOME の中だけで完結する。実 ~/.claude には触れない。
 *
 * Node 24 以降のネイティブ TypeScript 実行（型ストリッピング）と bun test の両方で
 * そのまま動かせるよう、package.json に "type": "module" がない前提の CommonJS で書く。
 */

type TestContext = import("node:test").TestContext;
type CliModule = typeof import("../src/claude-statusline");

interface SettingsJson {
  statusLine?: {
    type: string;
    command: string;
    refreshInterval?: number;
    enabled?: boolean;
    padding?: number;
    stack_with_default?: boolean;
  };
  permissions?: unknown;
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

const { test } = require("node:test") as typeof import("node:test");
const assert: typeof import("node:assert/strict") = require("node:assert/strict");
const fs = require("node:fs") as typeof import("node:fs");
const os = require("node:os") as typeof import("node:os");
const path = require("node:path") as typeof import("node:path");
const { spawnSync } = require("node:child_process") as typeof import("node:child_process");

const ROOT = path.join(__dirname, "..");
const BIN = path.join(ROOT, "bin", "claude-statusline.js");
const SCRIPT = path.join(ROOT, "statusline.py");
const PKG = require(path.join(ROOT, "package.json")) as { version: string };

// 解決ロジックはサブプロセス越しには通せない分岐を持つため、ビルド成果物を直接読み込む
const cli = require(BIN) as CliModule;

/** 使い捨ての HOME を作り、テスト終了時に消す。 */
function makeHome(t: TestContext, settings?: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "claude-statusline-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (settings !== undefined) {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(settingsPath(home), settings);
  }
  return home;
}

function settingsPath(home: string): string {
  return path.join(home, ".claude", "settings.json");
}

function claudeInstallDir(home: string): string {
  return path.join(home, ".claude", "claude-statusline");
}

function claudeScriptPath(home: string): string {
  return path.join(claudeInstallDir(home), "statusline.py");
}

function claudeVersionPath(home: string): string {
  return path.join(claudeInstallDir(home), "version");
}

function antigravitySettingsPath(home: string): string {
  return path.join(home, ".gemini", "antigravity-cli", "settings.json");
}

function antigravityInstallDir(home: string): string {
  return path.join(home, ".gemini", "antigravity-cli", "claude-statusline");
}

function antigravityScriptPath(home: string): string {
  return path.join(antigravityInstallDir(home), "statusline.py");
}

function antigravityVersionPath(home: string): string {
  return path.join(antigravityInstallDir(home), "version");
}

function readSettings(home: string): SettingsJson {
  return JSON.parse(fs.readFileSync(settingsPath(home), "utf8")) as SettingsJson;
}

function readAntigravitySettings(home: string): SettingsJson {
  return JSON.parse(fs.readFileSync(antigravitySettingsPath(home), "utf8")) as SettingsJson;
}

function writeAntigravitySettings(home: string, raw: string): void {
  const file = antigravitySettingsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, raw);
}

function run(args: string[], home: string, input?: string): RunResult {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    input,
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** 指定した 2 行を印字するだけの偽 python を作る。 */
function makeStub(t: TestContext, version: string, executable: string): string {
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

test("--install は statusLine を書き、無関係なキーを残す", (t: TestContext) => {
  const home = makeHome(t, JSON.stringify({ permissions: { allow: ["Bash"] }, env: { FOO: "1" } }));
  const r = run(["--install"], home);
  assert.equal(r.code, 0);
  const settings = readSettings(home);
  assert.deepEqual(settings.permissions, { allow: ["Bash"] });
  assert.deepEqual(settings.env, { FOO: "1" });
  assert.equal(settings.statusLine?.type, "command");
  assert.equal(settings.statusLine?.refreshInterval, 60);
  assert.match(settings.statusLine?.command ?? "", /statusline\.py/);
});

test("--install は冪等", (t: TestContext) => {
  const home = makeHome(t);
  run(["--install"], home);
  const first = fs.readFileSync(settingsPath(home), "utf8");
  run(["--install"], home);
  assert.equal(fs.readFileSync(settingsPath(home), "utf8"), first);
});

test("--install はパスを引用符で包む", (t: TestContext) => {
  const home = makeHome(t);
  run(["--install"], home);
  assert.match(readSettings(home).statusLine?.command ?? "", /^'[^']+' '[^']+'$/);
});

test("--runcat は環境変数の前置きを足す", (t: TestContext) => {
  const home = makeHome(t);
  run(["--install", "--runcat"], home);
  assert.match(readSettings(home).statusLine?.command ?? "", /^CLAUDE_STATUSLINE_RUNCAT=1 '/);
});

test("--runcat なしでは環境変数を書かない", (t: TestContext) => {
  const home = makeHome(t);
  run(["--install"], home);
  assert.doesNotMatch(readSettings(home).statusLine?.command ?? "", /CLAUDE_STATUSLINE_RUNCAT/);
});

// --- パーミッション ----------------------------------------------------

test("新規の settings.json は 0600、.claude は 0700 で作る", (t: TestContext) => {
  const home = makeHome(t);
  run(["--install"], home);
  assert.equal(fs.statSync(path.join(home, ".claude")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(settingsPath(home)).mode & 0o777, 0o600);
});

test("既存 settings.json のモードは変えない", (t: TestContext) => {
  const home = makeHome(t, "{}");
  fs.chmodSync(settingsPath(home), 0o644);
  run(["--install"], home);
  assert.equal(fs.statSync(settingsPath(home)).mode & 0o777, 0o644);
});

// --- バックアップ ------------------------------------------------------

test("既存ファイルがあればタイムスタンプ付きで退避する", (t: TestContext) => {
  const home = makeHome(t, '{"env":{"FOO":"1"}}');
  const r = run(["--install"], home);
  const backups = fs.readdirSync(path.join(home, ".claude")).filter((f) => f.includes(".bak-"));
  assert.equal(backups.length, 1);
  assert.match(r.stdout, /Backed up existing settings/);
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(home, ".claude", backups[0]!), "utf8")),
    { env: { FOO: "1" } }
  );
});

// --- 壊れた settings.json ----------------------------------------------

for (const [label, raw] of [
  ["配列", "[1,2,3]"],
  ["null", "null"],
  ["文字列", '"hello"'],
  ["数値", "42"],
] as const) {
  test(`settings.json が ${label} なら exit 1 で止まる`, (t: TestContext) => {
    const home = makeHome(t, raw);
    const r = run(["--install"], home);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /is not a JSON object/);
    // 未捕捉例外のスタックトレースを利用者に見せない
    assert.doesNotMatch(r.stderr, /^\s+at /m);
    assert.equal(fs.readFileSync(settingsPath(home), "utf8"), raw);
  });
}

test("settings.json が構文エラーなら上書きせず exit 1", (t: TestContext) => {
  const home = makeHome(t, "{oops");
  const r = run(["--install"], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is not valid JSON/);
  assert.equal(fs.readFileSync(settingsPath(home), "utf8"), "{oops");
});

test("空ファイルは新規扱いで通す", (t: TestContext) => {
  const home = makeHome(t, "  \n");
  assert.equal(run(["--install"], home).code, 0);
  assert.ok(readSettings(home).statusLine);
});

// --- --uninstall -------------------------------------------------------

test("--uninstall は自分の statusLine だけ消す", (t: TestContext) => {
  const home = makeHome(t, JSON.stringify({ env: { FOO: "1" } }));
  run(["--install"], home);
  const r = run(["--uninstall"], home);
  assert.equal(r.code, 0);
  const settings = readSettings(home);
  assert.equal(settings.statusLine, undefined);
  assert.deepEqual(settings.env, { FOO: "1" });
});

test("--uninstall は他ツールの statusLine を残す", (t: TestContext) => {
  const foreign = { type: "command", command: "/usr/local/bin/other-statusline" };
  const home = makeHome(t, JSON.stringify({ statusLine: foreign }));
  const r = run(["--uninstall"], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /points at a different program|different program/);
  assert.deepEqual(readSettings(home).statusLine, foreign);
});

test("--uninstall は statusLine がなければ何もしない", (t: TestContext) => {
  const home = makeHome(t, "{}");
  const r = run(["--uninstall"], home);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /nothing to uninstall/);
});

// --- フラグの扱い ------------------------------------------------------

test("未知のフラグは exit 1", (t: TestContext) => {
  const home = makeHome(t);
  const r = run(["--instal"], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown option: --instal/);
});

test("--version はパッケージのバージョンを出す", (t: TestContext) => {
  const home = makeHome(t);
  const r = run(["--version"], home);
  assert.equal(r.code, 0);
  assert.equal(r.stdout.trim(), PKG.version);
});

test("引数なしでは使い方を出して settings.json を作らない", (t: TestContext) => {
  const home = makeHome(t);
  const r = run([], home);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /--install/);
  assert.equal(fs.existsSync(settingsPath(home)), false);
});

// --- --print -----------------------------------------------------------

test("--print は stdin のペイロードを描画する", (t: TestContext) => {
  const home = makeHome(t);
  const r = run(["--print"], home, '{"model":{"display_name":"Opus 5"},"cwd":"/tmp/demo"}');
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Opus 5/);
});

// --- --python ----------------------------------------------------------

test("--python は指定したインタプリタを settings.json に焼く", (t: TestContext) => {
  const home = makeHome(t);
  const r = run(["--install", "--python", REAL_PYTHON], home);
  assert.equal(r.code, 0);
  assert.equal(
    readSettings(home).statusLine?.command,
    `'${REAL_PYTHON}' '${claudeScriptPath(home)}'`
  );
});

test("--python=<path> の形式も受ける", (t: TestContext) => {
  const home = makeHome(t);
  assert.equal(run(["--install", `--python=${REAL_PYTHON}`], home).code, 0);
  assert.match(readSettings(home).statusLine?.command ?? "", new RegExp(REAL_PYTHON));
});

test("--python に値がなければ exit 1", (t: TestContext) => {
  const home = makeHome(t);
  const r = run(["--install", "--python"], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /requires a path/);
});

test("--python の値が別のフラグなら exit 1", (t: TestContext) => {
  const home = makeHome(t);
  assert.equal(run(["--install", "--python", "--runcat"], home).code, 1);
});

test("--python の値は未知フラグ扱いしない", (t: TestContext) => {
  const home = makeHome(t);
  const r = run(["--install", "--python", REAL_PYTHON], home);
  assert.doesNotMatch(r.stderr, /unknown option/);
});

test("--python の指す先が実行できなければ exit 1", (t: TestContext) => {
  const home = makeHome(t);
  const r = run(["--install", "--python", "/nope/python3"], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /could not be run as a Python interpreter/);
  assert.equal(fs.existsSync(settingsPath(home)), false);
});

test("--python が版数を名乗れないなら exit 1", (t: TestContext) => {
  const home = makeHome(t);
  const stub = makeStub(t, "not-a-version", "/bin/sh");
  const r = run(["--install", "--python", stub], home);
  assert.equal(r.code, 1);
  assert.equal(fs.existsSync(settingsPath(home)), false);
});

test("--python が 3.8 未満なら exit 1", (t: TestContext) => {
  const home = makeHome(t);
  const stub = makeStub(t, "3.7", REAL_PYTHON);
  const r = run(["--install", "--python", stub], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /3\.8 or newer is required/);
});

test("--python では被検査プログラムが名乗った実体パスを採用しない", (t: TestContext) => {
  // 2 行目に印字した任意の文字列がインタプリタとして焼かれる経路を塞ぐ
  const home = makeHome(t);
  const stub = makeStub(t, "3.12", "/bin/sh");
  run(["--install", "--python", stub], home);
  const command = readSettings(home).statusLine?.command ?? "";
  assert.match(command, new RegExp(stub));
  assert.doesNotMatch(command, /\/bin\/sh/);
});

// --- インタプリタ解決の単体テスト --------------------------------------
// /usr/bin/python3 が在る環境では PATH 由来の候補まで到達しないため、
// resolvePython() をそのまま呼んでもこの分岐は踏めない。部品を直に叩く。

test("inspectPython は版数を解析できなければ null", (t: TestContext) => {
  assert.equal(cli.inspectPython(makeStub(t, "not-a-version", "/bin/sh")), null);
  assert.equal(cli.inspectPython(makeStub(t, "3", "/bin/sh")), null);
  assert.equal(cli.inspectPython(makeStub(t, "3.x", "/bin/sh")), null);
  assert.equal(cli.inspectPython("/nope/python3"), null);
});

test("inspectPython は本物の python3 から版数と実体パスを取る", () => {
  const info = cli.inspectPython(REAL_PYTHON);
  assert.ok(info !== null);
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
  assert.ok(info !== null);
  assert.equal(cli.verifiedExecutable(info), REAL_PYTHON);
});

test("parseArgs は --python の値をフラグから切り離す", () => {
  const parsed = cli.parseArgs(["--install", "--python", "/opt/python3", "--runcat"]);
  assert.deepEqual([...parsed.flags], ["--install", "--runcat"]);
  assert.equal(parsed.python, "/opt/python3");
  assert.equal(parsed.target, null);
  assert.deepEqual(parsed.unknown, []);

  const eq = cli.parseArgs(["--install", "--python=/opt/python3", "--target=antigravity"]);
  assert.equal(eq.python, "/opt/python3");
  assert.equal(eq.target, "antigravity");
  assert.deepEqual(eq.unknown, []);

  const space = cli.parseArgs(["--install", "--target", "all"]);
  assert.equal(space.target, "all");
  assert.deepEqual(space.unknown, []);

  assert.deepEqual(cli.parseArgs(["--nope"]).unknown, ["--nope"]);
});

// --- --target / Antigravity CLI 対応 -----------------------------------

test("--install --target antigravity は Antigravity 設定のみを書き 0700/0600 で作る", (t: TestContext) => {
  const home = makeHome(t);
  const r = run(["--install", "--target", "antigravity"], home);
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(settingsPath(home)), false);
  const agyFile = antigravitySettingsPath(home);
  assert.equal(fs.statSync(path.dirname(agyFile)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(agyFile).mode & 0o777, 0o600);
  const settings = readAntigravitySettings(home);
  assert.equal(settings.statusLine?.type, "command");
  assert.equal(settings.statusLine?.enabled, true);
  assert.equal(settings.statusLine?.padding, 0);
  assert.equal(settings.statusLine?.stack_with_default, false);
  assert.equal(settings.statusLine?.refreshInterval, undefined);
  assert.match(settings.statusLine?.command ?? "", /^'[^']+' '[^']+'$/);
});

test("--install --target=antigravity は無関係なキーを残し退避する", (t: TestContext) => {
  const home = makeHome(t);
  writeAntigravitySettings(home, JSON.stringify({ model: "Gemini 4", permissions: { allow: [] } }));
  const r = run(["--install", "--target=antigravity", "--runcat"], home);
  assert.equal(r.code, 0);
  const settings = readAntigravitySettings(home);
  assert.equal(settings.model, "Gemini 4");
  assert.deepEqual(settings.permissions, { allow: [] });
  assert.match(settings.statusLine?.command ?? "", /^CLAUDE_STATUSLINE_RUNCAT=1 '/);
  const backups = fs
    .readdirSync(path.dirname(antigravitySettingsPath(home)))
    .filter((f) => f.includes(".bak-"));
  assert.equal(backups.length, 1);
});

test("--install --target all は Claude Code と Antigravity CLI の両方に書く", (t: TestContext) => {
  const home = makeHome(t);
  const r = run(["--install", "--target", "all"], home);
  assert.equal(r.code, 0);
  assert.equal(readSettings(home).statusLine?.refreshInterval, 60);
  assert.equal(readAntigravitySettings(home).statusLine?.stack_with_default, false);
});

test("--uninstall --target antigravity は自分の statusLine だけ消す", (t: TestContext) => {
  const home = makeHome(t);
  writeAntigravitySettings(home, JSON.stringify({ model: "Gemini 4" }));
  assert.equal(run(["--install", "--target", "antigravity"], home).code, 0);
  const r = run(["--uninstall", "--target", "antigravity"], home);
  assert.equal(r.code, 0);
  const settings = readAntigravitySettings(home);
  assert.equal(settings.statusLine, undefined);
  assert.equal(settings.model, "Gemini 4");
});

test("--uninstall --target antigravity は他ツールや真偽値の statusLine を消さない", (t: TestContext) => {
  const home = makeHome(t);
  const foreign = { type: "command", command: "/usr/local/bin/other.sh" };
  writeAntigravitySettings(home, JSON.stringify({ statusLine: foreign }));
  const r1 = run(["--uninstall", "--target", "antigravity"], home);
  assert.equal(r1.code, 1);
  assert.match(r1.stderr, /different program/);
  assert.deepEqual(readAntigravitySettings(home).statusLine, foreign);

  writeAntigravitySettings(home, JSON.stringify({ statusLine: false }));
  const r2 = run(["--uninstall", "--target", "antigravity"], home);
  assert.equal(r2.code, 1);
  assert.equal(readAntigravitySettings(home).statusLine, false);
});

test("--uninstall --target all は両方の statusLine を消す", (t: TestContext) => {
  const home = makeHome(t);
  assert.equal(run(["--install", "--target", "all"], home).code, 0);
  const r = run(["--uninstall", "--target", "all"], home);
  assert.equal(r.code, 0);
  assert.equal(readSettings(home).statusLine, undefined);
  assert.equal(readAntigravitySettings(home).statusLine, undefined);
});

test("--target の不正値や欠落は exit 1", (t: TestContext) => {
  const home = makeHome(t);
  for (const args of [
    ["--install", "--target"],
    ["--install", "--target", "--runcat"],
    ["--install", "--target", "unknown"],
    ["--install", "--target=unknown"],
  ]) {
    const r = run(args, home);
    assert.equal(r.code, 1, args.join(" "));
    assert.match(r.stderr, /--target must be one of/);
  }
});

// --- 対象選択メニューと状態表示の単体テスト ----------------------------

test("formatTargetMenu は各対象の導入状態を表示する", () => {
  const menu = cli.formatTargetMenu("install", {
    claude: "installed",
    antigravity: "not installed",
  });
  assert.match(menu, /Select target to install statusLine:/);
  assert.match(menu, /1\) Claude Code \(~\/\.claude\/settings\.json\) \[installed\]/);
  assert.match(
    menu,
    /2\) Antigravity CLI \(~\/\.gemini\/antigravity-cli\/settings\.json\) \[not installed\]/
  );
  assert.match(menu, /3\) Both/);

  const otherMenu = cli.formatTargetMenu("uninstall", {
    claude: "other",
    antigravity: "installed",
  });
  assert.match(otherMenu, /Select target to uninstall statusLine:/);
  assert.match(otherMenu, /\[other tool configured\]/);
});

test("parseTargetChoice は番号・名前・空入力を解釈し不正値を拒否する", () => {
  assert.deepEqual(cli.parseTargetChoice(""), ["claude"]);
  assert.deepEqual(cli.parseTargetChoice("1"), ["claude"]);
  assert.deepEqual(cli.parseTargetChoice("claude"), ["claude"]);
  assert.deepEqual(cli.parseTargetChoice("2"), ["antigravity"]);
  assert.deepEqual(cli.parseTargetChoice("Antigravity"), ["antigravity"]);
  assert.deepEqual(cli.parseTargetChoice("3"), ["claude", "antigravity"]);
  assert.deepEqual(cli.parseTargetChoice("both"), ["claude", "antigravity"]);
  assert.deepEqual(cli.parseTargetChoice("all"), ["claude", "antigravity"]);
  assert.equal(cli.parseTargetChoice("9"), null);
  assert.equal(cli.parseTargetChoice("foo"), null);
});

test("inspectTargetStatus は未導入・導入済み・他ツール設定を判別する", (t: TestContext) => {
  const home = makeHome(t);
  const customTarget = {
    ...cli.TARGETS.antigravity,
    settingsPath: () => antigravitySettingsPath(home),
    installDir: () => antigravityInstallDir(home),
  };
  assert.equal(cli.inspectTargetStatus(customTarget), "not installed");

  writeAntigravitySettings(home, "{broken");
  assert.equal(cli.inspectTargetStatus(customTarget), "not installed");

  writeAntigravitySettings(
    home,
    JSON.stringify({ statusLine: { type: "command", command: "/other/script.sh" } })
  );
  assert.equal(cli.inspectTargetStatus(customTarget), "other");

  assert.equal(run(["--install", "--target", "antigravity"], home).code, 0);
  assert.equal(cli.inspectTargetStatus(customTarget), "installed");
});

test("バックアップファイルは元ファイルが 0644 でも 0600 で作成される", (t: TestContext) => {
  const home = makeHome(t);
  writeAntigravitySettings(home, '{"env":{"SECRET":"1"}}');
  const agyFile = antigravitySettingsPath(home);
  fs.chmodSync(agyFile, 0o644);
  const r = run(["--install", "--target", "antigravity"], home);
  assert.equal(r.code, 0);
  const dir = path.dirname(agyFile);
  const backups = fs.readdirSync(dir).filter((f) => f.includes(".bak-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.statSync(path.join(dir, backups[0]!)).mode & 0o777, 0o600);
});

test("settings.json が壊れたシンボリックリンクなら外部ファイルを作らず exit 1", (t: TestContext) => {
  const home = makeHome(t);
  const agyFile = antigravitySettingsPath(home);
  const outside = path.join(home, "outside-dangling.json");
  fs.mkdirSync(path.dirname(agyFile), { recursive: true });
  fs.symlinkSync(outside, agyFile);
  const r = run(["--install", "--target", "antigravity"], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /broken symbolic link/);
  assert.equal(fs.existsSync(outside), false);
});

test("--target all で片方の settings.json が壊れていれば 1 ファイルも変更しない", (t: TestContext) => {
  const home = makeHome(t, '{"env":{"FOO":"1"}}');
  writeAntigravitySettings(home, "{broken");
  const r = run(["--install", "--target", "all"], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is not valid JSON/);
  assert.equal(fs.readFileSync(settingsPath(home), "utf8"), '{"env":{"FOO":"1"}}');
  const claudeBackups = fs
    .readdirSync(path.join(home, ".claude"))
    .filter((f) => f.includes(".bak-"));
  assert.equal(claudeBackups.length, 0);
});

// --- コピーインストーラ・バージョン・清掃・移行 ------------------------

test("--install は statusline.py と version を ~/.claude/claude-statusline/ にコピーする", (t: TestContext) => {
  const home = makeHome(t);
  const r = run(["--install"], home);
  assert.equal(r.code, 0);
  const destScript = claudeScriptPath(home);
  const destVersion = claudeVersionPath(home);
  assert.equal(fs.readFileSync(destScript, "utf8"), fs.readFileSync(SCRIPT, "utf8"));
  assert.equal(fs.readFileSync(destVersion, "utf8").trim(), PKG.version);
  const command = readSettings(home).statusLine?.command ?? "";
  assert.ok(command.includes(destScript));
  assert.equal(command.includes(SCRIPT), false);
});

test("コピー先ディレクトリは 0700、statusline.py は 0700、version は 0600 で一時ファイルを残さない", (t: TestContext) => {
  const home = makeHome(t);
  assert.equal(run(["--install"], home).code, 0);
  const dir = claudeInstallDir(home);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(claudeScriptPath(home)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(claudeVersionPath(home)).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir).sort(), ["statusline.py", "version"]);
});

test("--install --target antigravity は Antigravity 配下にのみコピーし ~/.claude を作らない", (t: TestContext) => {
  const home = makeHome(t);
  const r = run(["--install", "--target", "antigravity"], home);
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(path.join(home, ".claude")), false);
  const dir = antigravityInstallDir(home);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(antigravityScriptPath(home)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(antigravityVersionPath(home)).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(antigravityScriptPath(home), "utf8"), fs.readFileSync(SCRIPT, "utf8"));
  assert.equal(fs.readFileSync(antigravityVersionPath(home), "utf8").trim(), PKG.version);
  assert.ok((readAntigravitySettings(home).statusLine?.command ?? "").includes(antigravityScriptPath(home)));
});

test("--install --target all は両ターゲットに独立してコピーし各 settings.json から指す", (t: TestContext) => {
  const home = makeHome(t);
  const r = run(["--install", "--target", "all"], home);
  assert.equal(r.code, 0);
  assert.ok((readSettings(home).statusLine?.command ?? "").includes(claudeScriptPath(home)));
  assert.ok(
    (readAntigravitySettings(home).statusLine?.command ?? "").includes(antigravityScriptPath(home))
  );
  assert.equal(fs.readFileSync(claudeScriptPath(home), "utf8"), fs.readFileSync(SCRIPT, "utf8"));
  assert.equal(
    fs.readFileSync(antigravityScriptPath(home), "utf8"),
    fs.readFileSync(SCRIPT, "utf8")
  );
});

test("再インストールは一時ファイル経由の rename で原子的に上書きする", (t: TestContext) => {
  const home = makeHome(t);
  assert.equal(run(["--install"], home).code, 0);
  const scriptPath = claudeScriptPath(home);
  const versionPath = claudeVersionPath(home);
  // 旧版のファイルが置かれている状態を模擬する
  fs.writeFileSync(scriptPath, "# old script\n", { mode: 0o644 });
  fs.writeFileSync(versionPath, "0.9.0\n", { mode: 0o644 });
  const beforeScriptIno = fs.statSync(scriptPath).ino;
  const beforeVersionIno = fs.statSync(versionPath).ino;

  assert.equal(run(["--install"], home).code, 0);
  assert.notEqual(fs.statSync(scriptPath).ino, beforeScriptIno);
  assert.notEqual(fs.statSync(versionPath).ino, beforeVersionIno);
  assert.equal(fs.readFileSync(scriptPath, "utf8"), fs.readFileSync(SCRIPT, "utf8"));
  assert.equal(fs.readFileSync(versionPath, "utf8").trim(), PKG.version);
  assert.equal(fs.statSync(scriptPath).mode & 0o777, 0o700);
  assert.equal(fs.statSync(versionPath).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(claudeInstallDir(home)).sort(), ["statusline.py", "version"]);
});

test("installDir がシンボリックリンクや通常ファイルなら settings.json を変えず exit 1", (t: TestContext) => {
  const home1 = makeHome(t, '{"env":{"FOO":"1"}}');
  const outside = path.join(home1, "outside-dir");
  fs.mkdirSync(outside, { recursive: true });
  fs.symlinkSync(outside, claudeInstallDir(home1));
  const r1 = run(["--install"], home1);
  assert.equal(r1.code, 1);
  assert.match(r1.stderr, /symbolic link/);
  assert.deepEqual(readSettings(home1), { env: { FOO: "1" } });
  assert.deepEqual(fs.readdirSync(outside), []);

  const home2 = makeHome(t, '{"env":{"BAR":"2"}}');
  fs.writeFileSync(claudeInstallDir(home2), "not a dir");
  const r2 = run(["--install"], home2);
  assert.equal(r2.code, 1);
  assert.match(r2.stderr, /not a directory/);
  assert.deepEqual(readSettings(home2), { env: { BAR: "2" } });
});

test("コピー先ファイル位置にディレクトリがあると settings.json を変えず exit 1", (t: TestContext) => {
  const home = makeHome(t, '{"env":{"FOO":"1"}}');
  fs.mkdirSync(claudeScriptPath(home), { recursive: true });
  const r = run(["--install"], home);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /is a directory/);
  assert.deepEqual(readSettings(home), { env: { FOO: "1" } });
});

test("--target all で片方の installDir がシンボリックリンクなら 1 ファイルも変更しない", (t: TestContext) => {
  const home = makeHome(t, '{"env":{"FOO":"1"}}');
  const outside = path.join(home, "outside-agy");
  fs.mkdirSync(outside, { recursive: true });
  fs.mkdirSync(path.dirname(antigravityInstallDir(home)), { recursive: true });
  fs.symlinkSync(outside, antigravityInstallDir(home));

  const r = run(["--install", "--target", "all"], home);
  assert.equal(r.code, 1);
  assert.equal(fs.existsSync(claudeInstallDir(home)), false);
  assert.deepEqual(readSettings(home), { env: { FOO: "1" } });
  assert.deepEqual(fs.readdirSync(outside), []);
});

test("--uninstall はコピー済みファイルと空の claude-statusline ディレクトリも消す", (t: TestContext) => {
  const home = makeHome(t);
  assert.equal(run(["--install"], home).code, 0);
  assert.equal(fs.existsSync(claudeInstallDir(home)), true);

  const r = run(["--uninstall"], home);
  assert.equal(r.code, 0);
  assert.equal(readSettings(home).statusLine, undefined);
  assert.equal(fs.existsSync(claudeScriptPath(home)), false);
  assert.equal(fs.existsSync(claudeVersionPath(home)), false);
  assert.equal(fs.existsSync(claudeInstallDir(home)), false);
});

test("--uninstall は claude-statusline 内の無関係なファイルを残して既知ファイルだけ消す", (t: TestContext) => {
  const home = makeHome(t);
  assert.equal(run(["--install"], home).code, 0);
  const extra = path.join(claudeInstallDir(home), "user-note.txt");
  fs.writeFileSync(extra, "keep me\n");

  const r = run(["--uninstall"], home);
  assert.equal(r.code, 0);
  assert.equal(fs.existsSync(claudeScriptPath(home)), false);
  assert.equal(fs.existsSync(claudeVersionPath(home)), false);
  assert.equal(fs.readFileSync(extra, "utf8"), "keep me\n");
});

test("--uninstall --target claude は Antigravity 側のコピー済みファイルと設定を残す", (t: TestContext) => {
  const home = makeHome(t);
  assert.equal(run(["--install", "--target", "all"], home).code, 0);
  assert.equal(run(["--uninstall", "--target", "claude"], home).code, 0);

  assert.equal(readSettings(home).statusLine, undefined);
  assert.equal(fs.existsSync(claudeInstallDir(home)), false);
  assert.ok(readAntigravitySettings(home).statusLine);
  assert.equal(fs.existsSync(antigravityScriptPath(home)), true);
  assert.equal(fs.existsSync(antigravityVersionPath(home)), true);
});

test("--uninstall は他ツールの statusLine が入っていればコピー先ディレクトリにも触れない", (t: TestContext) => {
  const home = makeHome(t);
  assert.equal(run(["--install"], home).code, 0);
  const foreign = { type: "command", command: "/usr/local/bin/other-statusline" };
  fs.writeFileSync(settingsPath(home), JSON.stringify({ statusLine: foreign }));

  const r = run(["--uninstall"], home);
  assert.equal(r.code, 1);
  assert.deepEqual(readSettings(home).statusLine, foreign);
  assert.equal(fs.existsSync(claudeScriptPath(home)), true);
  assert.equal(fs.existsSync(claudeVersionPath(home)), true);
});

test("--uninstall は statusLine 欠損時でも孤児ファイルを安全に清掃する", (t: TestContext) => {
  const home = makeHome(t);
  assert.equal(run(["--install"], home).code, 0);
  // 利用者が settings.json から手動で statusLine を消した状況を模擬
  fs.writeFileSync(settingsPath(home), "{}\n");

  const r = run(["--uninstall"], home);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /Removed leftover status line files/);
  assert.equal(fs.existsSync(claudeInstallDir(home)), false);
});

test("旧グローバルインストール形式の settings.json も導入済みと認識し移行・アンインストールできる", (t: TestContext) => {
  const home = makeHome(t);
  const legacyPath =
    "/Users/example/.volta/tools/image/packages/@chieeeeno/claude-statusline/lib/node_modules/@chieeeeno/claude-statusline/statusline.py";
  const legacySettings = JSON.stringify({
    statusLine: {
      type: "command",
      command: `'/usr/bin/python3' '${legacyPath}'`,
      refreshInterval: 60,
    },
  });
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(settingsPath(home), legacySettings);

  const customClaude = {
    ...cli.TARGETS.claude,
    settingsPath: () => settingsPath(home),
    installDir: () => claudeInstallDir(home),
  };
  assert.equal(cli.inspectTargetStatus(customClaude), "installed");

  // --version は旧方式であることを示す
  const ver = run(["--version"], home);
  assert.equal(ver.code, 0);
  assert.equal(
    ver.stdout.trim(),
    `${PKG.version}\ninstalled (Claude Code): legacy (package path)`
  );

  // --uninstall で旧方式の statusLine を消せる
  const un = run(["--uninstall"], home);
  assert.equal(un.code, 0);
  assert.equal(readSettings(home).statusLine, undefined);

  // 旧方式から --install でコピー方式へ切り替えられる
  fs.writeFileSync(settingsPath(home), legacySettings);
  assert.equal(run(["--install"], home).code, 0);
  assert.ok((readSettings(home).statusLine?.command ?? "").includes(claudeScriptPath(home)));
  assert.equal(fs.existsSync(claudeScriptPath(home)), true);
});

test("--version は導入済みターゲットのバージョンを CLI 版に併記する", (t: TestContext) => {
  const home = makeHome(t);
  // 未導入時は CLI 版のみ
  const empty = run(["--version"], home);
  assert.equal(empty.code, 0);
  assert.equal(empty.stdout.trim(), PKG.version);

  // 両方導入し、Antigravity 側だけ古いバージョンを模擬する
  assert.equal(run(["--install", "--target", "all"], home).code, 0);
  fs.writeFileSync(antigravityVersionPath(home), "2.0.0\n");

  const both = run(["--version"], home);
  assert.equal(both.code, 0);
  assert.deepEqual(both.stdout.trim().split("\n"), [
    PKG.version,
    `installed (Claude Code): ${PKG.version}`,
    "installed (Antigravity CLI): 2.0.0",
  ]);
});

test("formatTargetMenu は導入済みバージョンを表示する", () => {
  const menu = cli.formatTargetMenu(
    "install",
    { claude: "installed", antigravity: "installed" },
    { claude: "2.1.0", antigravity: null }
  );
  assert.match(menu, /1\) Claude Code \(~\/\.claude\/settings\.json\) \[installed v2\.1\.0\]/);
  assert.match(
    menu,
    /2\) Antigravity CLI \(~\/\.gemini\/antigravity-cli\/settings\.json\) \[installed\]/
  );
});

test("settings.json に書かれたコピー先のコマンドで実際にペイロードを描画できる", (t: TestContext) => {
  const home = makeHome(t);
  assert.equal(run(["--install", "--python", REAL_PYTHON], home).code, 0);
  const command = readSettings(home).statusLine?.command ?? "";
  const rendered = spawnSync("/bin/sh", ["-c", command], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
    input: '{"model":{"display_name":"Opus 5"},"cwd":"/tmp/demo"}',
  });
  assert.equal(rendered.status, 0);
  assert.match(rendered.stdout, /Opus 5/);
});
