#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync, spawnSync } = require("node:child_process");

const PKG_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(PKG_ROOT, "statusline.py");
const SETTINGS = path.join(os.homedir(), ".claude", "settings.json");
const MIN_PYTHON = { major: 3, minor: 8 };

function packageVersion() {
  return require(path.join(PKG_ROOT, "package.json")).version;
}

/**
 * シェルに安全に渡せる形に引用する。
 *
 * settings.json の command はシェル経由で実行されるため、引用せずにパスを
 * 連結すると、空白を含む設置先（iCloud Drive や Google Drive の配下など）で
 * 描画が壊れ、シェルメタ文字を含むディレクトリ名では任意コマンドが毎分
 * 実行される。単一引用で包み、内部の ' は閉じて連結し直す。
 *
 * @param {string} s 引用する文字列
 * @returns {string} 単一引用で包まれた文字列
 */
function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * 指定した python 実行ファイルのバージョンと実体パスを調べる。
 *
 * 版数が整数 2 つに解析できなければ null を返す。Number() は解析不能な出力に
 * NaN を返し、NaN はどの比較でも false になるため、素通しにすると最低版数の
 * 検査そのものが無効化される。
 *
 * @param {string} bin python の実行ファイル名またはパス
 * @returns {{major: number, minor: number, executable: string}|null} 実行できなければ null
 */
function inspectPython(bin) {
  let out;
  try {
    out = execFileSync(
      bin,
      ["-c", "import sys; print('%d.%d' % sys.version_info[:2]); print(sys.executable)"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }
    );
  } catch {
    return null;
  }
  const [version, executable] = out.trim().split("\n");
  const [major, minor] = String(version || "").split(".").map(Number);
  if (!Number.isInteger(major) || !Number.isInteger(minor)) return null;
  return { major, minor, executable: String(executable || "").trim() };
}

/**
 * 最低サポート版数を満たすか。
 * @param {{major: number, minor: number}|null} info inspectPython の戻り値
 * @returns {boolean}
 */
function meetsMinimum(info) {
  if (!info) return false;
  if (info.major !== MIN_PYTHON.major) return info.major > MIN_PYTHON.major;
  return info.minor >= MIN_PYTHON.minor;
}

/**
 * inspectPython が報告した sys.executable を採用してよいか確かめる。
 *
 * この値は被検査プログラムが 2 行目に印字した文字列にすぎず、そのまま採用すると
 * 任意のパスが settings.json に焼かれて毎分実行される。絶対パスであることに加え、
 * そのパス自身を実行して同じ版数を名乗ることまで確かめる。
 *
 * @param {{major: number, minor: number, executable: string}} info inspectPython の戻り値
 * @returns {string|null} 検証を通った実体パス。通らなければ null
 */
function verifiedExecutable(info) {
  const exe = info.executable;
  if (!exe || !path.isAbsolute(exe)) return null;
  const confirmed = inspectPython(exe);
  if (!confirmed) return null;
  if (confirmed.major !== info.major || confirmed.minor !== info.minor) return null;
  return exe;
}

/**
 * status line の実行に使う python のパスを決める。
 *
 * /usr/bin/python3 を最優先するのは、pyenv などのバージョン管理ツールの状態に
 * 左右されないため。pyenv の実体パスの方が起動は速いが、そのバージョンを削除
 * した時点で status line が動かなくなる。
 *
 * @returns {string|null} python のパス。見つからなければ null
 */
function resolvePython() {
  for (const candidate of ["/usr/bin/python3", "python3"]) {
    const info = inspectPython(candidate);
    if (!meetsMinimum(info)) continue;
    // 絶対パスの候補は実行できた時点で確定。それ以外は PATH 由来なので、
    // shim の実体を返す sys.executable を検証したうえで採用する
    if (path.isAbsolute(candidate)) return candidate;
    const executable = verifiedExecutable(info);
    if (executable) return executable;
  }
  return null;
}

/**
 * --python で明示指定されたインタプリタを検証する。
 * @param {string} value 利用者が渡したパス
 * @returns {string} 検証を通った絶対パス
 */
function explicitPython(value) {
  const target = path.resolve(value);
  const info = inspectPython(target);
  if (!info) {
    console.error(`claude-statusline: ${target} could not be run as a Python interpreter.`);
    process.exit(1);
  }
  if (!meetsMinimum(info)) {
    console.error(
      `claude-statusline: ${target} is Python ${info.major}.${info.minor}, but 3.8 or newer is required.`
    );
    process.exit(1);
  }
  return target;
}

function requirePython(explicit) {
  if (explicit) return explicitPython(explicit);
  const python = resolvePython();
  if (python) return python;
  console.error("claude-statusline: Python 3.8 or newer was not found.");
  console.error("  Install python3, or point at one with --python <path>.");
  process.exit(1);
}

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const raw = fs.readFileSync(SETTINGS, "utf8");
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error(`claude-statusline: ${SETTINGS} is not valid JSON: ${e.message}`);
    console.error("  Fix the file manually and try again.");
    process.exit(1);
  }
  // パースは通るがオブジェクトではない場合。配列に statusLine を足しても
  // JSON.stringify が名前付きプロパティを落とすため、成功を報告しながら
  // 設定が入っていないという最悪の結果になる。null や文字列は TypeError になる
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`claude-statusline: ${SETTINGS} is not a JSON object.`);
    console.error("  Fix the file manually and try again.");
    process.exit(1);
  }
  return parsed;
}

function backupSettings() {
  if (!fs.existsSync(SETTINGS)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${SETTINGS}.bak-${stamp}`;
  fs.copyFileSync(SETTINGS, dest);
  return dest;
}

// settings.json には env.ANTHROPIC_API_KEY のような機微な設定が入りうる。
// umask 任せだと共有ホストで他ローカルユーザーから読める 0644 で作られる。
// mode は新規作成時にしか効かないため、既存ファイルのモードは変えない。
function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true, mode: 0o700 });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

function install({ runcat, python: explicit }) {
  const python = requirePython(explicit);
  const settings = readSettings();
  const backup = backupSettings();

  settings.statusLine = {
    type: "command",
    command:
      (runcat ? "CLAUDE_STATUSLINE_RUNCAT=1 " : "") +
      `${shellQuote(python)} ${shellQuote(SCRIPT)}`,
    refreshInterval: 60,
  };
  writeSettings(settings);

  if (backup) console.log(`Backed up existing settings to ${backup}`);
  console.log(`Installed status line into ${SETTINGS}`);
  console.log(`  command: ${settings.statusLine.command}`);
  console.log("Claude Code picks this up without a restart.");
}

function uninstall() {
  const settings = readSettings();
  if (!settings.statusLine) {
    console.log("claude-statusline: nothing to uninstall (no statusLine entry).");
    return;
  }
  // 他のツールが設定した status line を消さない。
  // 引用ありの新形式と、引用なしで書かれた旧バージョンの設定の両方を認識する。
  // パスに ' を含む場合は引用時にエスケープされ、生のパスでは一致しないため。
  const current = String(settings.statusLine.command || "");
  if (!current.includes(SCRIPT) && !current.includes(shellQuote(SCRIPT))) {
    console.error("claude-statusline: statusLine points to a different program; leaving it alone.");
    console.error(`  current: ${settings.statusLine.command}`);
    process.exit(1);
  }
  const backup = backupSettings();
  delete settings.statusLine;
  writeSettings(settings);
  console.log(`Backed up existing settings to ${backup}`);
  console.log(`Removed status line from ${SETTINGS}`);
}

function print(explicit) {
  const python = requirePython(explicit);
  const result = spawnSync(python, [SCRIPT], { stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}

function usage() {
  console.log(`claude-statusline ${packageVersion()}

  claude-statusline --install [--runcat]  Write the statusLine entry into ~/.claude/settings.json
  claude-statusline --uninstall           Remove the statusLine entry
  claude-statusline --print               Render a payload read from stdin (for debugging)
  claude-statusline --version             Print the version
  claude-statusline --help                Show this message

  --runcat enables writing ~/.claude/runcat-usage.json for RunCat Neo (off by default).
  --python <path> pins the interpreter instead of looking for /usr/bin/python3 or one on PATH.`);
}

const KNOWN_FLAGS = new Set([
  "--install",
  "--uninstall",
  "--print",
  "--version",
  "--help",
  "--runcat",
]);

const PYTHON_FLAG = "--python";

/**
 * コマンドラインを 1 パスで読む。
 *
 * --python の値をフラグ検査から除くために、includes() ではなく走査で解く。
 *
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{flags: Set<string>, python: string|null, unknown: string[]}}
 */
function parseArgs(argv) {
  const flags = new Set();
  const unknown = [];
  let python = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === PYTHON_FLAG || arg.startsWith(`${PYTHON_FLAG}=`)) {
      // 値を取り違えると、その文字列がインタプリタとして settings.json に焼かれる。
      // 空や別のフラグを黙って受けない
      const value = arg === PYTHON_FLAG ? argv[++i] : arg.slice(PYTHON_FLAG.length + 1);
      if (!value || value.startsWith("-")) {
        console.error(`claude-statusline: ${PYTHON_FLAG} requires a path to a Python interpreter.`);
        console.error(`  example: claude-statusline --install ${PYTHON_FLAG} /opt/homebrew/bin/python3`);
        process.exit(1);
      }
      python = value;
      continue;
    }
    if (KNOWN_FLAGS.has(arg)) flags.add(arg);
    else unknown.push(arg);
  }
  return { flags, python, unknown };
}

function run(argv) {
  const { flags, python, unknown } = parseArgs(argv);
  const has = (flag) => flags.has(flag);

  // 打ち間違えたフラグを usage + exit 0 で返すと、`cmd && next` で繋いだ
  // セットアップスクリプトが成功と判断して先へ進んでしまう。
  if (unknown.length) {
    console.error(`claude-statusline: unknown option: ${unknown.join(", ")}`);
    console.error("  Run claude-statusline --help to see the available options.");
    process.exit(1);
  }

  if (has("--version")) console.log(packageVersion());
  else if (has("--install")) install({ runcat: has("--runcat"), python });
  else if (has("--uninstall")) uninstall();
  else if (has("--print")) print(python);
  else usage();
}

if (require.main === module) run(process.argv.slice(2));
// インタプリタ解決はサブプロセス越しには通せない分岐を持つ（/usr/bin/python3 が
// 在る環境では PATH 由来の候補に到達しない）。テストから直に呼べるようにしておく。
else module.exports = { inspectPython, meetsMinimum, verifiedExecutable, resolvePython, parseArgs };
