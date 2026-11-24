#!/usr/bin/env node

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as readlineEvents from "node:readline";
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
type OwnStatusLineKind = "copied" | "legacy";

interface TargetInspection {
  status: InstallStatus;
  kind: OwnStatusLineKind | null;
}

interface TargetSpec {
  id: TargetId;
  label: string;
  displayPath: string;
  settingsPath: () => string;
  installDir: () => string;
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
const INSTALLED_DIR_NAME = "claude-statusline";
const INSTALLED_SCRIPT_NAME = "statusline.py";
const INSTALLED_VERSION_NAME = "version";
// 旧グローバルインストール（v2.1.0 以前）で settings.json に書かれたパッケージ直指しの
// コマンドを認識するためのパターン。npx 経由で移行・アンインストールする際に使う。
const LEGACY_PACKAGE_SCRIPT_RE = /\/@chieeeeno\/claude-statusline\/statusline\.py(?:'|$|\s)/;
const MIN_PYTHON = { major: 3, minor: 8 } as const;

const TARGETS: Record<TargetId, TargetSpec> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    displayPath: "~/.claude/settings.json",
    settingsPath: () => path.join(os.homedir(), ".claude", "settings.json"),
    installDir: () => path.join(os.homedir(), ".claude", INSTALLED_DIR_NAME),
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
    installDir: () => path.join(os.homedir(), ".gemini", "antigravity-cli", INSTALLED_DIR_NAME),
    buildStatusLine: (command: string): StatusLineConfig => ({
      type: "command",
      command,
      enabled: true,
      padding: 0,
      stack_with_default: false,
    }),
  },
};

function targetScriptPath(target: TargetSpec): string {
  return path.join(target.installDir(), INSTALLED_SCRIPT_NAME);
}

function targetVersionPath(target: TargetSpec): string {
  return path.join(target.installDir(), INSTALLED_VERSION_NAME);
}

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
 * settings.json 内の statusLine が自ツールのコピー先か旧パッケージ直指しかを判定する。
 *
 * 引用ありの新形式と、引用なしで書かれた旧バージョンの設定の両方を認識する。
 * パスに ' を含む場合は引用時にエスケープされ、生のパスでは一致しないため。
 */
function classifyOwnStatusLine(statusLine: unknown, target: TargetSpec): OwnStatusLineKind | null {
  if (statusLine === null || typeof statusLine !== "object" || Array.isArray(statusLine)) {
    return null;
  }
  const current = String((statusLine as { command?: unknown }).command || "");
  const installedScript = targetScriptPath(target);
  if (current.includes(installedScript) || current.includes(shellQuote(installedScript))) {
    return "copied";
  }
  if (
    current.includes(SCRIPT) ||
    current.includes(shellQuote(SCRIPT)) ||
    LEGACY_PACKAGE_SCRIPT_RE.test(current)
  ) {
    return "legacy";
  }
  return null;
}

function isOwnStatusLine(statusLine: unknown, target: TargetSpec): boolean {
  return classifyOwnStatusLine(statusLine, target) !== null;
}

/** ターゲット配下に記録されたインストール済みバージョンを読む。読めなければ null。 */
function readInstalledVersion(target: TargetSpec): string | null {
  const dir = target.installDir();
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(dir);
  } catch {
    return null;
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return null;

  const versionFile = targetVersionPath(target);
  let fileStat: fs.Stats;
  try {
    fileStat = fs.lstatSync(versionFile);
  } catch {
    return null;
  }
  if (fileStat.isSymbolicLink() || !fileStat.isFile()) return null;

  try {
    const raw = fs.readFileSync(versionFile, "utf8");
    const firstLine = (raw.split(/\r?\n/, 1)[0] ?? "").trim();
    return firstLine || null;
  } catch {
    return null;
  }
}

/** 選択メニュー・バージョン表示用に対象の導入状態と方式を調べる（ファイル破損で終了しない）。 */
function inspectTargetDetail(target: TargetSpec): TargetInspection {
  const settingsFile = target.settingsPath();
  if (!fs.existsSync(settingsFile)) return { status: "not installed", kind: null };
  let parsed: unknown;
  try {
    const raw = fs.readFileSync(settingsFile, "utf8");
    if (!raw.trim()) return { status: "not installed", kind: null };
    parsed = JSON.parse(raw);
  } catch {
    return { status: "not installed", kind: null };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "not installed", kind: null };
  }
  const statusLine = (parsed as Settings).statusLine;
  if (statusLine === undefined) return { status: "not installed", kind: null };
  const kind = classifyOwnStatusLine(statusLine, target);
  return kind ? { status: "installed", kind } : { status: "other", kind: null };
}

/** 選択メニュー表示用に対象の現在の導入状態を調べる（ファイル破損で終了しない）。 */
function inspectTargetStatus(target: TargetSpec): InstallStatus {
  return inspectTargetDetail(target).status;
}

const TARGET_ORDER: readonly TargetId[] = ["claude", "antigravity"];

const ANSI_RESET = "\x1b[0m";
const ANSI_DIM = "\x1b[2m";
const ANSI_CYAN = "\x1b[36m";
const ANSI_GREEN = "\x1b[32m";
const ANSI_YELLOW = "\x1b[33m";
const CURSOR_HIDE = "\x1b[?25l";
const CURSOR_SHOW = "\x1b[?25h";
const ANSI_CSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const CONTROL_CHAR_RE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

interface CheckboxOption {
  id: TargetId;
  label: string;
  detail: string;
  badge: string;
}

interface CheckboxState {
  action: "install" | "uninstall";
  options: readonly CheckboxOption[];
  cursor: number;
  selected: ReadonlySet<TargetId>;
  error: string | null;
}

interface CheckboxKey {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

type CheckboxStepResult =
  | { kind: "continue"; state: CheckboxState }
  | { kind: "submit"; selected: TargetId[] }
  | { kind: "cancel" };

interface CheckboxInputStream extends NodeJS.ReadableStream {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
}

interface CheckboxOutputStream {
  write: (chunk: string) => boolean;
  columns?: number;
}

/** 端末エスケープや改行を含む制御文字を除去する。version ファイル汚染対策。 */
function sanitizeTerminalText(s: string): string {
  return s.replace(CONTROL_CHAR_RE, "");
}

function stripAnsi(s: string): string {
  return s.replace(ANSI_CSI_RE, "");
}

/** 端末幅での行折り返しを考慮した物理占有行数を返す。 */
function countPhysicalLines(lines: readonly string[], columns?: number): number {
  const width = typeof columns === "number" && columns > 0 ? Math.floor(columns) : 0;
  if (width === 0) return Math.max(1, lines.length);
  let total = 0;
  for (const line of lines) {
    const len = stripAnsi(line).length;
    total += Math.max(1, Math.ceil(len / width));
  }
  return Math.max(1, total);
}

function statusBadge(status: InstallStatus, version?: string | null): string {
  if (status === "installed") {
    const clean = version ? sanitizeTerminalText(version) : "";
    return clean ? `[installed v${clean}]` : "[installed]";
  }
  if (status === "other") return "[other tool configured]";
  return "[not installed]";
}

/**
 * 対話チェックボックスの初期選択状態を決める。
 *
 * 導入済みターゲットがある場合はそれらを初期チェックし（更新やアンインストール時に
 * そのまま Enter で対象へ適用できる）、未導入時のインストールは後方互換として
 * Claude Code を初期チェックする。
 */
function initialSelectedTargets(
  action: "install" | "uninstall",
  statuses: Record<TargetId, InstallStatus>
): TargetId[] {
  const installed = TARGET_ORDER.filter((id) => statuses[id] === "installed");
  if (installed.length > 0) return installed;
  return action === "install" ? ["claude"] : [];
}

function buildCheckboxOptions(
  statuses: Record<TargetId, InstallStatus>,
  versions?: Partial<Record<TargetId, string | null>>
): CheckboxOption[] {
  return TARGET_ORDER.map((id) => ({
    id,
    label: TARGETS[id].label,
    detail: TARGETS[id].displayPath,
    badge: statusBadge(statuses[id], versions?.[id]),
  }));
}

/** チェックボックス UI の 1 キー入力に対する状態遷移（純粋関数）。 */
function stepCheckboxState(state: CheckboxState, key: CheckboxKey): CheckboxStepResult {
  if (
    (key.ctrl && (key.name === "c" || key.name === "d")) ||
    key.name === "escape" ||
    (!key.ctrl && !key.meta && key.name === "q")
  ) {
    return { kind: "cancel" };
  }

  const count = state.options.length;
  if (count === 0) return { kind: "cancel" };

  if (key.name === "up" || (!key.ctrl && !key.meta && key.name === "k")) {
    return {
      kind: "continue",
      state: { ...state, cursor: (state.cursor - 1 + count) % count, error: null },
    };
  }
  if (key.name === "down" || (!key.ctrl && !key.meta && key.name === "j")) {
    return {
      kind: "continue",
      state: { ...state, cursor: (state.cursor + 1) % count, error: null },
    };
  }
  if (key.name === "space") {
    const current = state.options[state.cursor];
    if (!current) return { kind: "continue", state };
    const next = new Set(state.selected);
    if (next.has(current.id)) next.delete(current.id);
    else next.add(current.id);
    return { kind: "continue", state: { ...state, selected: next, error: null } };
  }
  if (!key.ctrl && !key.meta && key.name === "a") {
    const allSelected = state.options.every((opt) => state.selected.has(opt.id));
    const next = allSelected ? new Set<TargetId>() : new Set(state.options.map((opt) => opt.id));
    return { kind: "continue", state: { ...state, selected: next, error: null } };
  }
  if (key.name === "return" || key.name === "enter") {
    const selected = state.options.map((opt) => opt.id).filter((id) => state.selected.has(id));
    if (selected.length === 0) {
      return {
        kind: "continue",
        state: { ...state, error: "Select at least one target (press Space to toggle)." },
      };
    }
    return { kind: "submit", selected };
  }
  return { kind: "continue", state };
}

function renderCheckboxMenu(state: CheckboxState, opts?: { color?: boolean }): string[] {
  const color = opts?.color ?? false;
  const paint = (code: string, text: string): string =>
    color ? `${code}${text}${ANSI_RESET}` : text;
  const hint = paint(ANSI_DIM, "(↑↓ move, Space toggle, a all, Enter confirm, Esc cancel)");
  const lines = [`Select targets to ${state.action} statusLine ${hint}:`];
  for (let i = 0; i < state.options.length; i++) {
    const opt = state.options[i];
    if (!opt) continue;
    const active = i === state.cursor;
    const checked = state.selected.has(opt.id);
    const pointer = active ? paint(ANSI_CYAN, "❯") : " ";
    const box = checked ? paint(ANSI_GREEN, "◉") : paint(ANSI_DIM, "◯");
    const label = active ? paint(ANSI_CYAN, opt.label) : opt.label;
    const detail = paint(ANSI_DIM, `(${opt.detail}) ${opt.badge}`);
    lines.push(`${pointer} ${box} ${label} ${detail}`);
  }
  if (state.error) {
    lines.push(`  ${paint(ANSI_YELLOW, state.error)}`);
  }
  return lines;
}

function formatCheckboxSummary(
  action: "install" | "uninstall",
  selected: readonly TargetId[],
  opts?: { color?: boolean }
): string {
  const color = opts?.color ?? false;
  const mark = color ? `${ANSI_GREEN}✔${ANSI_RESET}` : "✔";
  const names = selected.map((id) => TARGETS[id].label).join(", ");
  return `${mark} Select targets to ${action} statusLine: ${names}`;
}

/**
 * raw mode + keypress イベントでチェックボックスプロンプトを実行する。
 *
 * 確定時は選択された TargetId[] を、キャンセルやストリーム終了時は null を返す。
 * 終了経路にかかわらず、必ず raw mode とカーソル表示を元の状態へ復元する。
 */
async function runCheckboxPrompt(
  initialState: CheckboxState,
  opts: {
    input: CheckboxInputStream;
    output: CheckboxOutputStream;
    color?: boolean;
    registerSignal?: boolean;
  }
): Promise<TargetId[] | null> {
  const { input, output, color = false, registerSignal = false } = opts;
  const wasRaw = Boolean(input.isRaw);
  let state = initialState;
  let prevPhysicalLines = 0;
  let rawActivated = false;
  let cursorHidden = false;
  let finished = false;

  if (typeof input.setRawMode === "function") {
    input.setRawMode(true);
    rawActivated = true;
  }

  return new Promise<TargetId[] | null>((resolve) => {
    const cleanup = (finalChunk = ""): void => {
      if (finished) return;
      finished = true;
      input.off("keypress", onKeypress);
      input.off("end", onStreamEnd);
      input.off("close", onStreamEnd);
      if (registerSignal) {
        process.off("SIGTERM", onSigterm);
        process.off("SIGINT", onSigint);
      }
      // macOS 等の libuv uv_tty_set_mode は TCSADRAIN で出力バッファが空になるまで待つため、
      // 最終出力を書き込む前に raw mode を戻してデッドロックを防ぐ。
      if (rawActivated && typeof input.setRawMode === "function") {
        try {
          input.setRawMode(wasRaw);
        } catch {
          // 既に閉じた端末での復元エラーは握りつぶす
        }
      }
      input.pause();
      const tail = cursorHidden ? `${finalChunk}${CURSOR_SHOW}` : finalChunk;
      cursorHidden = false;
      if (tail) output.write(tail);
    };

    const draw = (nextState: CheckboxState): void => {
      const lines = renderCheckboxMenu(nextState, { color });
      const frame = lines.join("\n");
      if (prevPhysicalLines === 0) {
        output.write(frame);
      } else {
        const moveUp = prevPhysicalLines > 1 ? `\x1b[${prevPhysicalLines - 1}A` : "";
        output.write(`\r${moveUp}\x1b[J${frame}`);
      }
      prevPhysicalLines = countPhysicalLines(lines, output.columns);
    };

    const onKeypress = (_str: string | undefined, key: CheckboxKey | undefined): void => {
      if (finished || !key) return;
      const result = stepCheckboxState(state, key);
      if (result.kind === "continue") {
        state = result.state;
        draw(state);
        return;
      }
      if (result.kind === "submit") {
        const moveUp = prevPhysicalLines > 1 ? `\x1b[${prevPhysicalLines - 1}A` : "";
        const summary = formatCheckboxSummary(state.action, result.selected, { color });
        cleanup(`\r${moveUp}\x1b[J${summary}\n`);
        resolve(result.selected);
        return;
      }
      cleanup("\n");
      resolve(null);
    };

    const onStreamEnd = (): void => {
      if (finished) return;
      cleanup("\n");
      resolve(null);
    };

    const onSigterm = (): void => {
      cleanup("\n");
      process.exit(143);
    };

    const onSigint = (): void => {
      cleanup("\n");
      process.exit(130);
    };

    readlineEvents.emitKeypressEvents(input);
    output.write(CURSOR_HIDE);
    cursorHidden = true;
    draw(state);

    input.on("keypress", onKeypress);
    input.once("end", onStreamEnd);
    input.once("close", onStreamEnd);
    if (registerSignal) {
      process.once("SIGTERM", onSigterm);
      process.once("SIGINT", onSigint);
    }
    input.resume();
  });
}

function formatTargetMenu(
  action: "install" | "uninstall",
  statuses: Record<TargetId, InstallStatus>,
  versions?: Partial<Record<TargetId, string | null>>
): string {
  const lines = [
    `Select target to ${action} statusLine:`,
    `  1) ${TARGETS.claude.label} (${TARGETS.claude.displayPath}) ${statusBadge(statuses.claude, versions?.claude)}`,
    `  2) ${TARGETS.antigravity.label} (${TARGETS.antigravity.displayPath}) ${statusBadge(statuses.antigravity, versions?.antigravity)}`,
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

/** raw mode 非対応の TTY（TERM=dumb 等）向け行入力フォールバック。 */
async function promptTargetSelectionFallback(
  action: "install" | "uninstall",
  statuses: Record<TargetId, InstallStatus>,
  versions: Record<TargetId, string | null>
): Promise<TargetId[]> {
  console.log(formatTargetMenu(action, statuses, versions));

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

async function promptTargetSelection(action: "install" | "uninstall"): Promise<TargetId[]> {
  const details: Record<TargetId, TargetInspection> = {
    claude: inspectTargetDetail(TARGETS.claude),
    antigravity: inspectTargetDetail(TARGETS.antigravity),
  };
  const statuses: Record<TargetId, InstallStatus> = {
    claude: details.claude.status,
    antigravity: details.antigravity.status,
  };
  const versions: Record<TargetId, string | null> = {
    claude: details.claude.kind === "copied" ? readInstalledVersion(TARGETS.claude) : null,
    antigravity:
      details.antigravity.kind === "copied" ? readInstalledVersion(TARGETS.antigravity) : null,
  };

  const canUseCheckbox =
    typeof process.stdin.setRawMode === "function" && process.env.TERM !== "dumb";
  if (canUseCheckbox) {
    const initialState: CheckboxState = {
      action,
      options: buildCheckboxOptions(statuses, versions),
      cursor: 0,
      selected: new Set(initialSelectedTargets(action, statuses)),
      error: null,
    };
    const color = !(process.env.NO_COLOR && process.env.NO_COLOR.length > 0);
    let chosen: TargetId[] | null;
    try {
      chosen = await runCheckboxPrompt(initialState, {
        input: process.stdin,
        output: process.stdout,
        color,
        registerSignal: true,
      });
    } catch {
      return promptTargetSelectionFallback(action, statuses, versions);
    }
    if (!chosen) {
      console.error("claude-statusline: cancelled.");
      process.exit(1);
    }
    return chosen;
  }

  return promptTargetSelectionFallback(action, statuses, versions);
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

function checkSettingsEntry(settingsFile: string): boolean {
  let lst: fs.Stats;
  try {
    lst = fs.lstatSync(settingsFile);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  if (lst.isSymbolicLink() && !fs.existsSync(settingsFile)) {
    console.error(
      `claude-statusline: ${settingsFile} is a broken symbolic link; refusing to write through it.`
    );
    console.error("  Remove or fix the symbolic link and try again.");
    process.exit(1);
  }
  return true;
}

function readSettings(settingsFile: string): Settings {
  if (!checkSettingsEntry(settingsFile)) return {};
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
  const content = fs.readFileSync(settingsFile);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${settingsFile}.bak-${stamp}`;
  // 元ファイルが緩い権限（0644 等）でも、退避ファイルは作成時点で 0600 かつ
  // 排他作成（O_EXCL）にして、機微情報の露出と同名ファイル／symlink 上書きを防ぐ。
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  for (let attempt = 0; attempt < 10; attempt++) {
    const dest = attempt === 0 ? base : `${base}-${attempt}`;
    let fd: number;
    try {
      fd = fs.openSync(dest, flags, 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    try {
      fs.writeFileSync(fd, content);
    } finally {
      fs.closeSync(fd);
    }
    return dest;
  }
  console.error(`claude-statusline: could not create backup file for ${settingsFile}.`);
  process.exit(1);
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

/**
 * コピー先ディレクトリと配置対象パスが安全に書き込める状態か事前検証する。
 *
 * installDir がシンボリックリンクや通常ファイルになっていれば、リンク先への
 * 誤書き込みを避けるため拒否する。配置先にディレクトリが居座る場合も rename が
 * 失敗するため先に止める。
 */
function checkInstallTarget(target: TargetSpec): void {
  const dir = target.installDir();
  let dirStat: fs.Stats | null = null;
  try {
    dirStat = fs.lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (dirStat) {
    if (dirStat.isSymbolicLink()) {
      console.error(
        `claude-statusline: ${dir} is a symbolic link; refusing to install into it.`
      );
      console.error("  Remove the symbolic link and try again.");
      process.exit(1);
    }
    if (!dirStat.isDirectory()) {
      console.error(`claude-statusline: ${dir} exists and is not a directory.`);
      console.error("  Remove or move the file and try again.");
      process.exit(1);
    }
  }

  for (const dest of [targetScriptPath(target), targetVersionPath(target)]) {
    let destStat: fs.Stats | null = null;
    try {
      destStat = fs.lstatSync(dest);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (destStat && destStat.isDirectory()) {
      console.error(`claude-statusline: ${dest} is a directory; refusing to overwrite it.`);
      console.error("  Remove or move the directory and try again.");
      process.exit(1);
    }
  }
}

/**
 * 同一ディレクトリ内の一時ファイル（O_EXCL）経由で原子的にファイルを置換する。
 *
 * statusline.py は高頻度で実行されるため、書き換え途中の部分読みを避ける。
 * rename は対象がシンボリックリンクでも追従せずリンク自体を置き換えるため、
 * 配置先シンボリックリンク経由の任意ファイル上書きも防げる。
 */
function writeFileAtomic(destPath: string, content: Buffer | string, mode: number): void {
  const dir = path.dirname(destPath);
  const base = path.basename(destPath);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  for (let attempt = 0; attempt < 10; attempt++) {
    const suffix = crypto.randomBytes(6).toString("hex");
    const tmpPath = path.join(dir, `.${base}.tmp-${process.pid}-${suffix}`);
    let fd: number;
    try {
      fd = fs.openSync(tmpPath, flags, mode);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw e;
    }
    try {
      fs.writeFileSync(fd, content);
    } catch (e) {
      fs.closeSync(fd);
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // 清掃失敗は元の例外を隠さない
      }
      throw e;
    }
    fs.closeSync(fd);
    try {
      fs.renameSync(tmpPath, destPath);
    } catch (e) {
      try {
        fs.unlinkSync(tmpPath);
      } catch {
        // 清掃失敗は元の例外を隠さない
      }
      throw e;
    }
    return;
  }
  console.error(`claude-statusline: could not create temporary file in ${dir}.`);
  process.exit(1);
}

/** ターゲット配下に statusline.py と version ファイルを原子的に配置する。 */
function installFiles(target: TargetSpec, scriptContent: Buffer, version: string): void {
  const dir = target.installDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileAtomic(targetScriptPath(target), scriptContent, 0o700);
  writeFileAtomic(targetVersionPath(target), `${version}\n`, 0o600);
}

/**
 * ターゲット配下にコピーした既知ファイルだけを削除し、空ならディレクトリも消す。
 *
 * 利用者が独自に置いたファイルを誤って消さないよう rm -rf は使わない。
 * installDir がシンボリックリンクの場合も追従せず手を付けない。
 */
function removeInstalledFiles(target: TargetSpec): boolean {
  const dir = target.installDir();
  let dirStat: fs.Stats;
  try {
    dirStat = fs.lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false;

  let removed = false;
  for (const filePath of [targetScriptPath(target), targetVersionPath(target)]) {
    let st: fs.Stats;
    try {
      st = fs.lstatSync(filePath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    if (st.isDirectory()) continue;
    fs.unlinkSync(filePath);
    removed = true;
  }

  try {
    fs.rmdirSync(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") throw e;
  }
  return removed;
}

function installTarget(
  target: TargetSpec,
  settings: Settings,
  command: string,
  version: string
): void {
  const settingsFile = target.settingsPath();
  const backup = backupSettings(settingsFile);

  const entry = target.buildStatusLine(command);
  settings.statusLine = entry;
  writeSettings(settingsFile, settings);

  if (backup) console.log(`Backed up existing settings to ${backup}`);
  console.log(`Installed status line (${target.label}) into ${settingsFile}`);
  console.log(`  script:  ${targetScriptPath(target)} (v${version})`);
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
  const scriptContent = fs.readFileSync(SCRIPT);
  const version = packageVersion();

  // 書き込み前に全対象の settings.json とコピー先を検証し、片方が壊れているときの半適用を防ぐ
  const prepared = targetIds.map((id) => {
    const target = TARGETS[id];
    const settings = readSettings(target.settingsPath());
    checkInstallTarget(target);
    return { target, settings };
  });

  const runcatPrefix = runcat ? "CLAUDE_STATUSLINE_RUNCAT=1 " : "";
  for (const { target, settings } of prepared) {
    // settings.json より先にスクリプトを配置し、存在しないパスを指す瞬間を作らない
    installFiles(target, scriptContent, version);
    const command = `${runcatPrefix}${shellQuote(python)} ${shellQuote(targetScriptPath(target))}`;
    installTarget(target, settings, command, version);
  }
  console.log("Changes take effect without a restart.");
}

function uninstallTarget(target: TargetSpec, settings: Settings): boolean {
  const settingsFile = target.settingsPath();
  if (settings.statusLine === undefined) {
    const cleaned = removeInstalledFiles(target);
    if (cleaned) {
      console.log(`Removed leftover status line files (${target.label}) from ${target.installDir()}`);
      return true;
    }
    console.log(
      `claude-statusline: nothing to uninstall for ${target.label} (no statusLine entry).`
    );
    return true;
  }
  // 他のツールが設定した status line を消さない。コピー先ディレクトリにも触れない。
  if (!isOwnStatusLine(settings.statusLine, target)) {
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
  const removedFiles = removeInstalledFiles(target);
  if (backup) console.log(`Backed up existing settings to ${backup}`);
  console.log(`Removed status line (${target.label}) from ${settingsFile}`);
  if (removedFiles) console.log(`Removed installed files from ${target.installDir()}`);
  return true;
}

async function uninstall(explicitTarget: TargetSelection | null): Promise<void> {
  const targetIds = await resolveTargets("uninstall", explicitTarget);
  // 書き込み前に全対象の settings.json を読み込み検証し、片方が壊れているときの半適用を防ぐ
  const prepared = targetIds.map((id) => {
    const target = TARGETS[id];
    return { target, settings: readSettings(target.settingsPath()) };
  });
  let ok = true;
  for (const { target, settings } of prepared) {
    if (!uninstallTarget(target, settings)) ok = false;
  }
  if (!ok) process.exit(1);
}

function printVersion(): void {
  console.log(packageVersion());
  for (const id of ["claude", "antigravity"] as const) {
    const target = TARGETS[id];
    const detail = inspectTargetDetail(target);
    if (detail.status !== "installed") continue;
    if (detail.kind === "legacy") {
      console.log(`installed (${target.label}): legacy (package path)`);
    } else {
      const installed = readInstalledVersion(target);
      const safeInstalled = installed ? sanitizeTerminalText(installed) : "";
      console.log(`installed (${target.label}): ${safeInstalled || "unknown"}`);
    }
  }
}

function print(explicit: string | null): never {
  const python = requirePython(explicit);
  const result = spawnSync(python, [SCRIPT], { stdio: "inherit" });
  process.exit(result.status === null ? 1 : result.status);
}

function usage(): void {
  console.log(`claude-statusline ${packageVersion()}

  claude-statusline --install [--target <target>] [--runcat]  Copy statusline.py and write statusLine into settings.json
  claude-statusline --uninstall [--target <target>]           Remove the statusLine entry and copied files
  claude-statusline --print                                   Render a payload read from stdin (for debugging)
  claude-statusline --version                                 Print CLI and installed versions
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

  if (has("--version")) printVersion();
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
  readInstalledVersion,
  inspectTargetDetail,
  inspectTargetStatus,
  initialSelectedTargets,
  buildCheckboxOptions,
  stepCheckboxState,
  renderCheckboxMenu,
  formatCheckboxSummary,
  countPhysicalLines,
  runCheckboxPrompt,
  formatTargetMenu,
  parseTargetChoice,
  parseArgs,
};
