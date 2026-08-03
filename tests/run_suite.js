"use strict";

/**
 * CLI テストを実行し、通った件数が下限を割ったら失敗させる。
 *
 * node --test は 1 件も収集できなくても exit 0 を返す（テストファイルを
 * 空にすると再現する）。テストの失敗と「テストが無い」ことを、どちらも
 * exit 1 に揃えるための包み。
 *
 * ファイルを名指しせず列挙するのは、逆向きの穴を開けないため。名指しにすると
 * tests/ にテストを足しても走らず、落ちるテストを追加したのに CI が緑になる。
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const FILES = fs
  .readdirSync(__dirname)
  .filter((f) => f.endsWith(".test.js"))
  .sort()
  .map((f) => path.join(__dirname, f));
const MINIMUM = 30;

if (FILES.length === 0) {
  console.error("claude-statusline: no *.test.js files found in tests/");
  process.exit(1);
}

const tapDir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-statusline-tap-"));
const tapFile = path.join(tapDir, "out.tap");

// 既定のレポータは stdout が TTY かどうかで変わる。集計に使う TAP は
// 出力先ごと明示して、対話実行と CI で同じ判定になるようにする。
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=tap",
    `--test-reporter-destination=${tapFile}`,
    ...FILES,
  ],
  { stdio: "inherit" }
);

const tap = fs.existsSync(tapFile) ? fs.readFileSync(tapFile, "utf8") : "";
fs.rmSync(tapDir, { recursive: true, force: true });

if (result.status !== 0) process.exit(result.status === null ? 1 : result.status);

const passed = Number((/^# pass (\d+)$/m.exec(tap) || [])[1]);
if (!(passed >= MINIMUM)) {
  console.error(`claude-statusline: expected at least ${MINIMUM} passing CLI tests, saw ${passed}`);
  process.exit(1);
}
console.log(`cli tests ok: ${passed} passed (minimum ${MINIMUM})`);
