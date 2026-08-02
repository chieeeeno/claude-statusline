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
 * 指定した python 実行ファイルのバージョンと実体パスを調べる。
 * @param {string} bin python の実行ファイル名またはパス
 * @returns {{major: number, minor: number, executable: string}|null} 実行できなければ null
 */
function inspectPython(bin) {
  try {
    const out = execFileSync(
      bin,
      ["-c", "import sys; print('%d.%d' % sys.version_info[:2]); print(sys.executable)"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }
    );
    const [version, executable] = out.trim().split("\n");
    const [major, minor] = version.split(".").map(Number);
    return { major, minor, executable };
  } catch {
    return null;
  }
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
    if (!info) continue;
    if (info.major < MIN_PYTHON.major) continue;
    if (info.major === MIN_PYTHON.major && info.minor < MIN_PYTHON.minor) continue;
    // shim 経由で呼ばれても sys.executable は実体を返すため、それを採用する
    return candidate === "/usr/bin/python3" ? candidate : info.executable;
  }
  return null;
}

function requirePython() {
  const python = resolvePython();
  if (python) return python;
  console.error("claude-statusline: Python 3.8 or newer was not found.");
  console.error("  Install python3 and run this command again.");
  process.exit(1);
}

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const raw = fs.readFileSync(SETTINGS, "utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    console.error(`claude-statusline: ${SETTINGS} is not valid JSON: ${e.message}`);
    console.error("  Fix the file manually and try again.");
    process.exit(1);
  }
}

function backupSettings() {
  if (!fs.existsSync(SETTINGS)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${SETTINGS}.bak-${stamp}`;
  fs.copyFileSync(SETTINGS, dest);
  return dest;
}

function writeSettings(settings) {
  fs.mkdirSync(path.dirname(SETTINGS), { recursive: true });
  fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

function install({ runcat }) {
  const python = requirePython();
  const settings = readSettings();
  const backup = backupSettings();

  settings.statusLine = {
    type: "command",
    command: `${runcat ? "CLAUDE_STATUSLINE_RUNCAT=1 " : ""}${python} ${SCRIPT}`,
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
  // 他のツールが設定した status line を消さない
  if (!String(settings.statusLine.command || "").includes(SCRIPT)) {
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

function print() {
  const python = requirePython();
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

  --runcat enables writing ~/.claude/runcat-usage.json for RunCat Neo (off by default).`);
}

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);

if (has("--version")) console.log(packageVersion());
else if (has("--install")) install({ runcat: has("--runcat") });
else if (has("--uninstall")) uninstall();
else if (has("--print")) print();
else usage();
