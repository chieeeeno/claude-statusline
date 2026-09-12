# @chieeeeno/claude-statusline

[日本語](README.md) | **English**

A fast, dependency-free status line for [Claude Code](https://claude.com/claude-code).

```
📁 my-repo  ⧉ feature-branch
⑂ feature/add-search  🧠 Opus 5 (1M)  ⚡ xhigh  📖 Explanatory  🤔 on
ctx ▓░░░░░░░░░ 10% 98k/1M │ 🔥 5h ▓▓▓▓▓▓▓░░░ 67% ↺2:03 (12:33) │ 📅 7d ▓▓░░░░░░░░ 22% ↺5d (5/23 10:30) │ 💰 $2.69 · 12m
```

## Why another status line?

- **No Node at render time.** The status line is rendered by Python (~40ms). Node is used only
  to write the settings entry during setup. Node-based status lines pay 100ms+ of startup on
  every redraw, against a 300ms debounce window.
- **Rate limit windows.** Shows your 5-hour and 7-day usage together with the time left until
  each window resets and the local clock time it resets at (`↺2:03 (12:33)`) — so you can see
  whether to keep going or wrap up. The date is added when the reset falls on another day.
- **Zero dependencies.** Python standard library only.

## Install

```bash
npm install -g @chieeeeno/claude-statusline
claude-statusline --install
```

That writes a `statusLine` entry into `~/.claude/settings.json` (backing up the existing file
first). Claude Code picks it up without a restart.

To update:

```bash
npm update -g @chieeeeno/claude-statusline
```

No need to re-run `--install` — the settings entry points at the package directory, so the new
version takes effect immediately.

## What it shows

| Line | Content |
|---|---|
| 1 | Repository name (from the `origin` remote) and git worktree name |
| 2 | Branch, model, reasoning effort, output style, thinking, fast mode |
| 3 | Context usage, 5-hour window, 7-day window, cost / elapsed time / lines changed |

Usage bars turn green → yellow → orange → red at 50% / 75% / 90%.

Segments disappear entirely when their data is unavailable — no `--` placeholders. Rate limit
windows are only reported for Claude.ai subscribers (Pro/Max), so they will not appear on
usage-based API plans.

## Commands

```
claude-statusline --install [--runcat]  Write the statusLine entry into ~/.claude/settings.json
claude-statusline --uninstall           Remove the statusLine entry
claude-statusline --print               Render a payload read from stdin (for debugging)
claude-statusline --version             Print the version
```

Preview it without changing any settings:

```bash
echo '{"model":{"display_name":"Opus 5"},"context_window":{"used_percentage":25,"total_input_tokens":50000,"context_window_size":200000}}' \
  | claude-statusline --print
```

`--uninstall` leaves a `statusLine` alone if it points at a different program, so it will not
clobber another tool's setting.

### Choosing the interpreter

Setup prefers `/usr/bin/python3`, then falls back to the first `python3` on `PATH`. On systems
without `/usr/bin/python3` (NixOS, Alpine, some containers) the fallback bakes whatever `PATH`
resolved to at setup time into `settings.json`, where it then runs every minute. Pin it instead:

```bash
claude-statusline --install --python /opt/homebrew/bin/python3
```

The path is checked before it is written: it must run, and it must report Python 3.8 or newer.

### RunCat Neo integration

With `--install --runcat`, the status line also writes `~/.claude/runcat-usage.json` in the
format [RunCat Neo](https://apps.apple.com/app/runcat) reads, so your model, context, and rate
limit usage show up in the macOS menu bar. Off by default — nothing is written unless you ask
for it.

## Requirements

- macOS or Linux (Windows is not supported)
- Python 3.8+ (uses the standard library only)
- Node 18+ (setup only)
- git (for the branch segment; everything else still renders without it)

## Development

```bash
npm test         # both suites
npm run test:py  # statusline.py, via unittest
npm run test:js  # bin/claude-statusline.js, via node:test
```

No dev dependencies: the Python suite uses `unittest` and the CLI suite uses Node's built-in
test runner. Both wrappers fail when the suite collects fewer tests than expected — an empty or
missing test file exits 0 on its own, which would otherwise turn a deleted suite into a green CI
run. Every CLI test runs against a throwaway `HOME`, so your real `~/.claude` is never touched.

## License

MIT
