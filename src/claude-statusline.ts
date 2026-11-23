#!/usr/bin/env node

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline/promises";
import { execFileSync, spawnSync } from "node:child_process";

interface PythonInfo {
  major: number;
  minor: number;
  executable: string;
}

interface StatusLineConfig {
  type: string;
  command: string;
  refreshInterval?: number;
  enabled?: boolean;
  padding?: number;
  stack_with_default?: boolean;
}

interface Settings {
  statusLine?: StatusLineConfig | unknown;
  [key: string]: unknown;
}

type TargetId = "claude" | "antigravity";
type TargetSelection = TargetId | "all";
type InstallStatus = "installed" | "not installed" | "other";

interface TargetSpec {
  id: TargetId;
  label: string;
  displayPath: string;
  settingsPath: () => string;
  buildStatusLine: (command: string) => StatusLineConfig;
}

interface ParsedArgs {
  flags: Set<string>;
  python: string | null;
  target: TargetSelection | null;
  unknown: string[];
}

const PKG_ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(PKG_ROOT, "statusline.py");
const MIN_PYTHON = { major: 3, minor: 8 } as const;

const TARGETS: Record<TargetId, TargetSpec> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    displayPath: "~/.claude/settings.json",
    settingsPath: () => path.join(os.homedir(), ".claude", "settings.json"),
    buildStatusLine: (command: string): StatusLineConfig => ({
      type: "command",
      command,
      refreshInterval: 60,
    }),
  },
  antigravity: {
    id: "antigravity",
    label: "Antigravity CLI",
    displayPath: "~/.gemini/antigravity-cli/settings.json",
    settingsPath: () => path.join(os.homedir(), ".gemini", "antigravity-cli", "settings.json"),
    buildStatusLine: (command: string): StatusLineConfig => ({
      type: "command",
      command,
      enabled: true,
      padding: 0,
      stack_with_default: false,
    }),
  },
};

const VALID_TARGETS: ReadonlySet<string> = new Set(["claude", "antigravity", "all"]);

function packageVersion(): string {
  const pkg = require(path.join(PKG_ROOT, "package.json")) as { version: string };
  return pkg.version;
}

/**
 * シェルに安全に渡せる形に引用する。
 *
 * settings.json の command はシェル経由で実行されるため、引用せずにパスを
 * 連結すると、空白を含む設置先（iCloud Drive や Google Drive の配下など）で
 * 描画が壊れ、シェルメタ文字を含むディレクトリ名では任意コマンドが毎分
 * 実行される。単一引用で包み、内部の ' は閉じて連結し直す。
 */
function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

/**
 * 指定した python 実行ファイルのバージョンと実体パスを調べる。
 *
 * 版数が整数 2 つに解析できなければ null を返す。Number() は解析不能な出力に
 * NaN を返し、NaN はどの比較でも false になるため、素通しにすると最低版数の
 * 検査そのものが無効化される。
 */
function inspectPython(bin: string): PythonInfo | null {
  let out: string;
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
  if (
    major === undefined ||
    minor === undefined ||
    !Number.isInteger(major) ||
    !Number.isInteger(minor)
  ) {
    return null;
  }
  return { major, minor, executable: String(executable || "").trim() };
}

/** 最低サポート版数を満たすか。 */
function meetsMinimum(info: Pick<PythonInfo, "major" | "minor"> | null): boolean {
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
 */
function verifiedExecutable(info: PythonInfo): string | null {
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
 */
function resolvePython(): string | null {
  for (const candidate of ["/usr/bin/python3", "python3"]) {
    const info = inspectPython(candidate);
    if (!meetsMinimum(info)) continue;
    // 絶対パスの候補は実行できた時点で確定。それ以外は PATH 由来なので、
    // shim の実体を返す sys.executable を検証したうえで採用する
    if (path.isAbsolute(candidate)) return candidate;
    if (!info) continue;
    const executable = verifiedExecutable(info);
    if (executable) return executable;
  }
  return null;
}

/** --python で明示指定されたインタプリタを検証する。 */
function explicitPython(value: string): string {
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

function requirePython(explicit: string | null): string {
  if (explicit) return explicitPython(explicit);
  const python = resolvePython();
  if (python) return python;
  console.error("claude-statusline: Python 3.8 or newer was not found.");
  console.error("  Install python3, or point at one with --python <path>.");
  process.exit(1);
}

/**
 * settings.json 内の statusLine が自パッケージを指しているか判定する。
 *
 * 引用ありの新形式と、引用なしで書かれた旧バージョンの設定の両方を認識する。
 * パスに ' を含む場合は引用時にエスケープされ、生のパスでは一致しないため。
 */
function isOwnStatusLine(statusLine: unknown): boolean {
  if (statusLine === null || typeof statusLine !== "object" || Array.isArray(statusLine)) {
    return false;
  }
  const current = String((statusLine as { command?: unknown }).command || "");
  return current.includes(SCRIPT) || current.includes(shellQuote(SCRIPT));
}

/** 選択メニュー表示用に対象の現在の導入状態を調べる（ファイル破損で終了しない）。 */
function inspectTargetStatus(target: TargetSpec): InstallStatus {
  const settingsFile = target.settingsPath();
  if (!fs.existsSync(settingsFile)) return "not installed";
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(settingsFile, "utf8");
    if (!raw.trim()) return "not installed";
    parsed = JSON.parse(raw);
  } catch {
    return "not installed";
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return "not installed";
  }
  const statusLine = (parsed as Settings).statusLine;
  if (statusLine === undefined) return "not installed";
  return isOwnStatusLine(statusLine) ? "installed" : "other";
}

function statusBadge(status: InstallStatus): string {
  if (status === "installed") return "[installed]";
  if (status === "other") return "[other tool configured]";
  return "[not installed]";
}

function formatTargetMenu(
  action: "install" | "uninstall",
  statuses: Record<TargetId, InstallStatus>
): string {
  const lines = [
    `Select target to ${action} statusLine:`,
    `  1) ${TARGETS.claude.label} (${TARGETS.claude.displayPath}) ${statusBadge(statuses.claude)}`,
    `  2) ${TARGETS.antigravity.label} (${TARGETS.antigravity.displayPath}) ${statusBadge(statuses.antigravity)}`,
    "  3) Both",
  ];
  return lines.join("\n");
}

function parseTargetChoice(input: string): TargetId[] | null {
  const normalized = input.trim().toLowerCase();
  if (normalized === "" || normalized === "1" || normalized === "claude") return ["claude"];
  if (normalized === "2" || normalized === "antigravity") return ["antigravity"];
  if (normalized === "3" || normalized === "both" || normalized === "all") {
    return ["claude", "antigravity"];
  }
  return null;
}

async function promptTargetSelection(action: "install" | "uninstall"): Promise<TargetId[]> {
  const statuses: Record<TargetId, InstallStatus> = {
    claude: inspectTargetStatus(TARGETS.claude),
    antigravity: inspectTargetStatus(TARGETS.antigravity),
  };
  console.log(formatTargetMenu(action, statuses));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = await rl.question("Enter choice [1-3] (default: 1): ");
  } catch {
    console.error("\nclaude-statusline: cancelled.");
    process.exit(1);
  } finally {
    rl.close();
  }

  const chosen = parseTargetChoice(answer);
  if (!chosen) {
    console.error(`claude-statusline: invalid choice: ${answer.trim()}`);
    process.exit(1);
  }
  return chosen;
}

async function resolveTargets(
  action: "install" | "uninstall",
  explicit: TargetSelection | null
): Promise<TargetId[]> {
  if (explicit === "all") return ["claude", "antigravity"];
  if (explicit) return [explicit];
  if (process.stdin.isTTY && process.stdout.isTTY) {
    return promptTargetSelection(action);
  }
  return ["claude"];
}

function readSettings(settingsFile: string): Settings {
  if (!fs.existsSync(settingsFile)) return {};
  const raw = fs.readFileSync(settingsFile, "utf8");
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`claude-statusline: ${settingsFile} is not valid JSON: ${message}`);
    console.error("  Fix the file manually and try again.");
    process.exit(1);
  }
  // パースは通るがオブジェクトではない場合。配列に statusLine を足しても
  // JSON.stringify が名前付きプロパティを落とすため、成功を報告しながら
  // 設定が入っていないという最悪の結果になる。null や文字列は TypeError になる
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(`claude-statusline: ${settingsFile} is not a JSON object.`);
    console.error("  Fix the file manually and try again.");
    process.exit(1);
  }
  return parsed as Settings;
}

function backupSettings(settingsFile: string): string | null {
  if (!fs.existsSync(settingsFile)) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = `${settingsFile}.bak-${stamp}`;
  fs.copyFileSync(settingsFile, dest);
  return dest;
}

// settings.json には env.ANTHROPIC_API_KEY のような機微な設定が入りうる。
// umask 任せだと共有ホストで他ローカルユーザーから読める 0644 で作られる。
// mode は新規作成時にしか効かないため、既存ファイルのモードは変えない。
function writeSettings(settingsFile: string, settings: Settings): void {
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600,
  });
}

function installTarget(target: TargetSpec, command: string): void {
  const settingsFile = target.settingsPath();
  const settings = readSettings(settingsFile);
  const backup = backupSettings(settingsFile);

  const entry = target.buildStatusLine(command);
  settings.statusLine = entry;
  writeSettings(settingsFile, settings);

  if (backup) console.log(`Backed up existing settings to ${backup}`);
  console.log(`Installed status line (${target.label}) into ${settingsFile}`);
  console.log(`  command: ${entry.command}`);
}

async function install({
  runcat,
  python: explicitPythonPath,
  target: explicitTarget,
}: {
  runcat: boolean;
  python: string | null;
  target: TargetSelection | null;
}): Promise<void> {
  const targetIds = await resolveTargets("install", explicitTarget);
  const python = requirePython(explicitPythonPath);
  const command =
    (runcat ? "CLAUDE_STATUSLINE_RUNCAT=1 " : "") + `${shellQuote(python)} ${shellQuote(SCRIPT)}`;

  for (const id of targetIds) {
    installTarget(TARGETS[id], command);
  }
  console.log("Changes take effect without a restart.");
}

function uninstallTarget(target: TargetSpec): boolean {
  const settingsFile = target.settingsPath();
  const settings = readSettings(settingsFile);
  if (settings.statusLine === undefined) {
    console.log(
      `claude-statusline: nothing to uninstall for ${target.label} (no statusLine entry).`
    );
    return true;
  }
  // 他のツールが設定した status line を消さない。
  if (!isOwnStatusLine(settings.statusLine)) {
    const current =
      settings.statusLine !== null && typeof settings.statusLine === "object"
        ? String((settings.statusLine as { command?: unknown }).command || "")
        : String(settings.statusLine);
    console.error(
      `claude-statusline: ${target.label} statusLine points to a different program; leaving it alone.`
    );
    console.error(`  current: ${current}`);
    return false;
  }
  const backup = backupSettings(settingsFile);
  delete settings.statusLine;
  writeSettings(settingsFile, settings);
  if (backup) console.log(`Backed up existing settings to ${backup}`);
  console.log(`Removed status line (${target.label}) from ${settingsFile}`);
  return true;
}

async function uninstall(explicitTarget: TargetSelection | null): Promise<void> {
  const targetIds = await resolveTargets("uninstall", explicitTarget);
  let ok = true;
  for (const id of targetIds) {
    if (!uninstallTarget(TARGETS[id])) ok = false;
  }
  if (!ok) process.exit(1);
}

function print(explicit: string | null): never {
  const python = requirePython(explicit);
  const result = spawnSync(python, [SCRIPT], { stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}

function usage(): void {
  console.log(`claude-statusline ${packageVersion()}

  claude-statusline --install [--target <target>] [--runcat]  Write the statusLine entry into settings.json
  claude-statusline --uninstall [--target <target>]           Remove the statusLine entry
  claude-statusline --print                                   Render a payload read from stdin (for debugging)
  claude-statusline --version                                 Print the version
  claude-statusline --help                                    Show this message

  --target <claude|antigravity|all> selects the target CLI (prompts on a TTY; defaults to claude otherwise).
  --runcat enables writing runcat-usage.json for RunCat Neo (off by default).
  --python <path> pins the interpreter instead of looking for /usr/bin/python3 or one on PATH.`);
}

const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  "--install",
  "--uninstall",
  "--print",
  "--version",
  "--help",
  "--runcat",
]);

const PYTHON_FLAG = "--python";
const TARGET_FLAG = "--target";

/**
 * コマンドラインを 1 パスで読む。
 *
 * --python / --target の値をフラグ検査から除くために、includes() ではなく走査で解く。
 */
function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const unknown: string[] = [];
  let python: string | null = null;
  let target: TargetSelection | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
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
    if (arg === TARGET_FLAG || arg.startsWith(`${TARGET_FLAG}=`)) {
      const value = arg === TARGET_FLAG ? argv[++i] : arg.slice(TARGET_FLAG.length + 1);
      if (!value || value.startsWith("-") || !VALID_TARGETS.has(value)) {
        console.error(
          `claude-statusline: ${TARGET_FLAG} must be one of: claude, antigravity, all.`
        );
        console.error(`  example: claude-statusline --install ${TARGET_FLAG} antigravity`);
        process.exit(1);
      }
      target = value as TargetSelection;
      continue;
    }
    if (KNOWN_FLAGS.has(arg)) flags.add(arg);
    else unknown.push(arg);
  }
  return { flags, python, target, unknown };
}

async function run(argv: string[]): Promise<void> {
  const { flags, python, target, unknown } = parseArgs(argv);
  const has = (flag: string): boolean => flags.has(flag);

  // 打ち間違えたフラグを usage + exit 0 で返すと、`cmd && next` で繋いだ
  // セットアップスクリプトが成功と判断して先へ進んでしまう。
  if (unknown.length) {
    console.error(`claude-statusline: unknown option: ${unknown.join(", ")}`);
    console.error("  Run claude-statusline --help to see the available options.");
    process.exit(1);
  }

  if (has("--version")) console.log(packageVersion());
  else if (has("--install")) await install({ runcat: has("--runcat"), python, target });
  else if (has("--uninstall")) await uninstall(target);
  else if (has("--print")) print(python);
  else usage();
}

if (require.main === module) {
  void run(process.argv.slice(2));
}

// インタプリタ解決や対話メニュー整形はサブプロセス越しには通せない分岐を持つ
// （/usr/bin/python3 が在る環境では PATH 由来の候補に到達しない、非 TTY では
// 対話プロンプトに入らない等）。テストから直に呼べるようにしておく。
export {
  TARGETS,
  inspectPython,
  meetsMinimum,
  verifiedExecutable,
  resolvePython,
  inspectTargetStatus,
  formatTargetMenu,
  parseTargetChoice,
  parseArgs,
};
