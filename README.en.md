# @chieeeeno/claude-statusline

[日本語](README.md) | **English**

A fast, dependency-free status line for [Claude Code](https://claude.com/claude-code) and [Google Antigravity CLI (`agy`)](https://antigravity.google).

```
🤖 Claude Code  📁 my-repo  ⧉ feature-branch
⑂ feature/add-search  🧠 Opus 5 (1M)  ⚡ xhigh  📖 Explanatory  🤔 on
ctx ▓░░░░░░░░░ 10% 98k/1M │ 🔥 5h ▓▓▓▓▓▓▓░░░ 67% ↺2:03 (12:33) │ 📅 7d ▓▓░░░░░░░░ 22% ↺5d (5/23 10:30) │ 💰 $2.69 · 12m
```

## Why another status line?

- **No Node at render time.** The status line is rendered by Python (~40ms). Node is used only
  during setup to copy `statusline.py` and write the settings entry. Node-based status lines pay
  100ms+ of startup on every redraw, against a 300ms debounce window.
- **Rate limit & quota windows.** Shows your 5-hour and 7-day usage (including Antigravity CLI
  `quota` buckets) together with the time left until each window resets and the local clock time
  it resets at (`↺2:03 (12:33)`) — so you can see whether to keep going or wrap up. The date is
  added when the reset falls on another day.
- **Zero dependencies.** Python standard library only.

## Install

```bash
npx @chieeeeno/claude-statusline --install
```

No global install required. `--install` atomically copies `statusline.py` into a stable directory
under each CLI (`~/.claude/claude-statusline/statusline.py` for Claude Code,
`~/.gemini/antigravity-cli/claude-statusline/statusline.py` for Antigravity CLI) and points
`settings.json` directly at that copy — so clearing the `npx` cache never breaks it, and Node is
never started at render time.

On an interactive terminal (TTY), `--install` displays the current status of each CLI and asks
which target to configure:

```
Select target to install statusLine:
  1) Claude Code (~/.claude/settings.json) [installed v2.1.0]
  2) Antigravity CLI (~/.gemini/antigravity-cli/settings.json) [not installed]
  3) Both
Enter choice [1-3] (default: 1):
```

That writes a `statusLine` entry into the target `settings.json` (`~/.claude/settings.json` for
Claude Code, `~/.gemini/antigravity-cli/settings.json` for Antigravity CLI), backing up the
existing file first. Both pick it up without a restart.

In non-interactive environments or scripts, pass `--target` explicitly (defaults to `claude` when
omitted on a non-TTY for backward compatibility):

```bash
npx @chieeeeno/claude-statusline --install --target claude
npx @chieeeeno/claude-statusline --install --target antigravity
npx @chieeeeno/claude-statusline --install --target all
```

### Update

```bash
npx @chieeeeno/claude-statusline@latest --install
```

Because `statusline.py` is copied into each target directory, re-run `--install` when updating to a
new release (the script is atomically replaced via a temporary file and `rename`, and the installed
version is recorded alongside it).

### Migrating from a global install

Existing `settings.json` entries from earlier global installs (`npm install -g`) that point at the
package directory continue to work without breaking. Running
`npx @chieeeeno/claude-statusline@latest --install` switches over to the copied script, after which
you can remove the global package with `npm uninstall -g @chieeeeno/claude-statusline`.

## What it shows

| Line | Content |
|---|---|
| 1 | Active agent name (`Claude Code` / `Antigravity`), repository name (from the `origin` remote), and git worktree name |
| 2 | Branch, model, reasoning effort, output style, thinking, fast mode |
| 3 | Context usage, 5-hour window, 7-day window, cost / elapsed time / lines changed |

Usage bars turn green → yellow → orange → red at 50% / 75% / 90%.

Segments disappear entirely when their data is unavailable — no `--` placeholders. Rate limit
windows are only reported for Claude.ai subscribers (Pro/Max), so they will not appear on
usage-based API plans.

## Commands

```
npx @chieeeeno/claude-statusline --install [--target <target>] [--runcat]  Copy statusline.py and write statusLine into settings.json
npx @chieeeeno/claude-statusline --uninstall [--target <target>]           Remove the statusLine entry and copied files
npx @chieeeeno/claude-statusline --print                                   Render a payload read from stdin (for debugging)
npx @chieeeeno/claude-statusline --version                                 Print CLI and installed versions
```

`--target` accepts `claude`, `antigravity`, or `all`. On a TTY, omitting it opens the interactive
selector.

Preview it without changing any settings:

```bash
echo '{"model":{"display_name":"Opus 5"},"context_window":{"used_percentage":25,"total_input_tokens":50000,"context_window_size":200000}}' \
  | npx @chieeeeno/claude-statusline --print
```

`--uninstall` leaves both `settings.json` and the copied directory alone if `statusLine` points at a
different program, so it will not clobber another tool's setting.

### Choosing the interpreter

Setup prefers `/usr/bin/python3`, then falls back to the first `python3` on `PATH`. On systems
without `/usr/bin/python3` (NixOS, Alpine, some containers) the fallback bakes whatever `PATH`
resolved to at setup time into `settings.json`, where it then runs every minute. Pin it instead:

```bash
npx @chieeeeno/claude-statusline --install --python /opt/homebrew/bin/python3
```

The path is checked before it is written: it must run, and it must report Python 3.8 or newer.

### RunCat Neo integration

With `--install --runcat`, the status line also writes `runcat-usage.json` in the format
[RunCat Neo](https://apps.apple.com/app/runcat) reads (`~/.claude/runcat-usage.json` for Claude
Code, `~/.gemini/antigravity-cli/runcat-usage.json` for Antigravity CLI), so your model, context,
and rate limit / quota usage show up in the macOS menu bar. Off by default — nothing is written
unless you ask for it.

## Requirements

- macOS or Linux (Windows is not supported)
- Python 3.8+ (uses the standard library only)
- Node 24+ (setup only)
- git (for the branch segment; everything else still renders without it)

## Development

Development uses [Bun](https://bun.sh/).

```bash
bun install        # install devDependencies (typescript / @types/node)
bun run typecheck  # type-check
bun run build      # compile src/claude-statusline.ts → bin/claude-statusline.js
bun run test       # both suites
bun run test:py    # statusline.py, via unittest
bun run test:js    # build, then run bin/claude-statusline.js via node:test
bun test           # fast local CLI test run (requires build first)
```

Runtime `dependencies` remain empty. `devDependencies` are kept to `typescript` and `@types/node` for compiling and type-checking the setup CLI; the Python suite uses `unittest` and the CLI suite uses Node's built-in `node:test` runner. Both wrappers fail when the suite collects fewer tests than expected — an empty or missing test file exits 0 on its own, which would otherwise turn a deleted suite into a green CI run. Every CLI test runs against a throwaway `HOME`, so your real `~/.claude` is never touched.

### Development & Release Skills

The repository includes skills shared across Claude Code and Antigravity CLI (via `.agents/skills.json`):

- `statusline-review` ([design doc](docs/01-review-skill-design.md)): runs parallel quality and security review agents over a PR diff with an automated fix-and-re-review loop
- `statusline-release` ([design doc](docs/03-release-skill-design.md)): runs the end-to-end release flow — collecting unreleased changes, choosing a stable semver version, opening/merging the version-bump PR, pushing a `vX.Y.Z` tag to trigger OIDC Trusted Publishing (`.github/workflows/publish.yml`), verifying npm publication, and creating the GitHub Release. Local `npm publish` (and `bun`/`pnpm`/`yarn publish`) is blocked at multiple layers via `.claude/settings.json`, `.agents/hooks.json`, and `package.json` `prepublishOnly`.

## License

MIT
