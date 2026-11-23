---
name: statusline-release
description: Run the safe npm release workflow for this repository via GitHub Actions Trusted Publishing (OIDC) - collect unreleased changes since the last v* tag, determine stable semver X.Y.Z, run local checks, open and merge the release/vX.Y.Z PR, create and push the vX.Y.Z tag on main, watch publish.yml and verify npm availability, and create the GitHub Release. Use when preparing or executing a release of @chieeeeno/claude-statusline. Never runs local npm publish.
---

# statusline-release

Standardizes and executes a safe release of `@chieeeeno/claude-statusline` using the repository's
Trusted Publishing (OIDC) workflow (`.github/workflows/publish.yml`).

Announce at the start: 「`statusline-release` スキルでリリース手順を実行します」

## Before anything else

Read `docs/03-release-skill-design.md`. It is the single source of truth for:
- The version-bump PR body template (PR #28 style)
- The GitHub Release notes template
- The design rationale and guardrails

Do not invent ad-hoc templates; follow the templates in `docs/03-release-skill-design.md` and fill
them with **real measured values**.

### Runtime note (Claude Code / Antigravity CLI)

This skill works in both Claude Code and Google Antigravity CLI (`agy`, via `.agents/skills.json`).
- Commands that talk to GitHub, git remotes, or the npm registry (`gh`, `git fetch`, `git push`,
  `git pull`, `npm view`) require network/auth access. In Antigravity CLI, run those steps outside
  the terminal sandbox when needed.
- Local publish commands (`npm publish`, `bun publish`, `pnpm publish`, `yarn publish`) are blocked
  mechanically (`.claude/settings.json`, `.agents/hooks.json`, and `package.json` `prepublishOnly`).
  **Never attempt to run or bypass them.**

---

## Step 1: Preconditions & Unreleased Diff

Check authentication, remote, working tree cleanliness, and sync with `origin/main`:

```bash
gh auth status
git remote -v
git status --porcelain
git fetch origin --tags
```

**Stop if any of the following is true:**
- `gh` is unauthenticated or `origin` is not configured
- `git status --porcelain` is non-empty (uncommitted changes exist)

Ensure you are on `main` and synced with `origin/main`:

```bash
git checkout main
git pull --ff-only origin main
```

**Stop if fast-forward pull fails** (diverged local `main` must be resolved manually).

Collect the latest release tag, current `package.json` version, and unreleased commits/PRs:

```bash
LAST_TAG=$(git tag -l 'v*' --sort=-v:refname | head -n 1)
CURRENT_VER=$(node -p "require('./package.json').version")
echo "LAST_TAG=$LAST_TAG CURRENT_VER=$CURRENT_VER"
git log "${LAST_TAG}..HEAD" --oneline
gh pr list --state merged --base main --limit 20 --json number,title,mergedAt,url
```

Check the result:
- **No commits since `LAST_TAG` (`git rev-list --count "${LAST_TAG}..HEAD"` is `0`)**: Stop and tell
  the user there are no unreleased changes.
- **Resume case**: If `CURRENT_VER` is already newer than `${LAST_TAG#v}` and `v${CURRENT_VER}` does
  not exist as a tag yet (e.g., the `release/vX.Y.Z` PR was already merged), inform the user clearly
  and ask whether to resume directly at **Step 4 (Tag creation & push)** for `v${CURRENT_VER}`.
- **Review check**: For feature/fix PRs included since `LAST_TAG`, check whether `statusline-review`
  (or an equivalent review) reached LGTM (`gh pr view <num> --json body,reviews`). If any change PR
  appears unreviewed, warn the user explicitly before proceeding.

---

## Step 2: Determine Next Version & Local Verification

1. Analyze the unreleased commits/PRs and determine the appropriate semver bump:
   - `patch`: bug fixes, CI/docs/tooling updates with no user-facing behavior or compatibility change
   - `minor`: backward-compatible new features
   - `major`: breaking changes (e.g., Node/Python support drop, incompatible CLI/output changes)
2. **Stable semver only**: `.github/workflows/publish.yml` rejects any tag not matching
   `^v[0-9]+\.[0-9]+\.[0-9]+$`. Never propose prerelease suffixes (`-alpha.1`, `-rc.1`, etc.).
3. Check for tag and npm registry collisions before proposing:

```bash
TARGET_VER="<X.Y.Z>"
git rev-parse -q --verify "refs/tags/v${TARGET_VER}" || echo "local tag ok"
git ls-remote --tags origin "refs/tags/v${TARGET_VER}"
npm view @chieeeeno/claude-statusline versions --json
```

**Stop if `v<X.Y.Z>` already exists locally, on `origin`, or in the npm registry.**

### Confirmation Gate 1 — Confirm Target Version

Present to the user:
- Latest tag (`LAST_TAG`) and current `package.json` version (`CURRENT_VER`)
- Summary of unreleased commits/PRs and their `statusline-review` LGTM status
- Proposed semver bump (`patch` / `minor` / `major`) with rationale, and target version `X.Y.Z`

**Wait for explicit user approval of `X.Y.Z` before making any branch or edit.**

### Local Pre-release Verification

Once `X.Y.Z` is approved, run the full local check suite and record actual measured numbers:

```bash
bun run typecheck
bun run test
bun run prepack
npm pack --dry-run --ignore-scripts --json
```

Verify the tarball JSON against the exact invariants enforced by `.github/workflows/publish.yml`:
- Exact 6 files: `LICENSE`, `README.en.md`, `README.md`, `bin/claude-statusline.js`, `package.json`, `statusline.py`
- No leaked files (`.claude/`, `.agents/`, `.github/`, `docs/`, `tests/`, `handover/`, `src/`, `tsconfig*.json`, `bun.lock`)
- `dependencies` is empty, `publishConfig.access === "public"`, `os` is `["darwin", "linux"]`
- Both `statusline.py` and `bin/claude-statusline.js` have executable bits (`mode & 0o111`)

**Stop if any check fails.** Fix the issue first rather than releasing a broken tree.

---

## Step 3: Version-Bump PR (`release/vX.Y.Z`)

1. Create the release branch from up-to-date `main`:

```bash
git checkout -b "release/v${TARGET_VER}" main
```

2. Update **only** `"version"` in `package.json` to `${TARGET_VER}`, then inspect `git diff` to
   confirm it is strictly a 1-line change:

```bash
git diff
```

3. Re-run quick sanity verification after updating `package.json`:

```bash
bun run typecheck && bun run test
```

4. Commit and push using the repository's release commit convention (`X.Y.Z に上げる`):

```bash
git add package.json
git commit -m "${TARGET_VER} に上げる"
git push -u origin "release/v${TARGET_VER}"
```

5. Draft the PR body strictly following the **バージョン上げ PR 本文テンプレート** in
   `docs/03-release-skill-design.md` (with real measured test counts and tarball details), and open
   the PR against `main`:

```bash
gh pr create --base main --head "release/v${TARGET_VER}" \
  --title "${TARGET_VER} に上げる" \
  --body-file /tmp/statusline-release-pr.md
```

6. Wait for all CI checks (`test.yml`) to pass:

```bash
gh pr checks --watch
```

**Stop if any CI check fails.** Report the failing job and logs to the user.

### Confirmation Gate 2 — Approve PR Merge

Present the PR URL and CI check results to the user and ask for explicit approval to merge into
`main`. **Do not merge without user confirmation.**

After approval:

```bash
gh pr merge --squash --delete-branch
```

---

## Step 4: Tag Creation, Push & OIDC Publish Monitoring

1. Switch back to `main` and pull the merged commit:

```bash
git checkout main
git pull --ff-only origin main
git fetch origin --tags
```

2. Run **all five pre-tag guardrails** before asking to tag:

```bash
BRANCH=$(git rev-parse --abbrev-ref HEAD)
DIRTY=$(git status --porcelain)
LOCAL_SHA=$(git rev-parse HEAD)
REMOTE_SHA=$(git rev-parse origin/main)
PKG_VER=$(node -p "require('./package.json').version")
LOCAL_TAG=$(git rev-parse -q --verify "refs/tags/v${TARGET_VER}" || true)
REMOTE_TAG=$(git ls-remote --tags origin "refs/tags/v${TARGET_VER}")
```

**Stop immediately if ANY guardrail fails:**
- `BRANCH` is not `main`
- `DIRTY` is non-empty
- `LOCAL_SHA` != `REMOTE_SHA`
- `PKG_VER` != `TARGET_VER` (or does not match `^[0-9]+\.[0-9]+\.[0-9]+$`)
- `LOCAL_TAG` or `REMOTE_TAG` is non-empty (tag already exists)

### Confirmation Gate 3 — Approve Tag Push (Triggers Public npm Publish)

Present to the user:
- Target branch (`main`) and exact commit SHA (`LOCAL_SHA`)
- Tag name (`v${TARGET_VER}`) and verified `package.json` version (`${PKG_VER}`)
- Reminder that pushing `v${TARGET_VER}` triggers `.github/workflows/publish.yml` and publishes
  `@chieeeeno/claude-statusline@${TARGET_VER}` publicly to npm via OIDC

**Wait for explicit user approval before tagging or pushing.**

After approval, create an annotated tag and push it:

```bash
git tag -a "v${TARGET_VER}" -m "v${TARGET_VER}"
git push origin "v${TARGET_VER}"
```

3. Locate and watch the `publish.yml` workflow run (wait a few seconds if GitHub Actions has not
   registered the run yet):

```bash
gh run list --workflow publish.yml --branch "v${TARGET_VER}" --limit 5 \
  --json databaseId,status,conclusion,headSha,url
gh run watch <run-id> --exit-status
```

**If `publish.yml` fails:**
- Inspect logs with `gh run view <run-id> --log-failed`
- Report the failure cause and run URL to the user and **STOP**
- **Do NOT** create a GitHub Release, and **do NOT** delete or move the pushed tag without explicit
  user instruction

4. Verify npm registry publication (retry briefly if npm CDN has not propagated yet):

```bash
npm view "@chieeeeno/claude-statusline@${TARGET_VER}" version dist.tarball
npm view @chieeeeno/claude-statusline dist-tags --json
```

**Stop if `@chieeeeno/claude-statusline@${TARGET_VER}` is not visible on npm after retrying.**

---

## Step 5: GitHub Release Creation

1. Confirm a GitHub Release for `v${TARGET_VER}` does not already exist:

```bash
gh release view "v${TARGET_VER}" 2>/dev/null && echo "ALREADY EXISTS" || echo "NOT YET"
```

If it already exists, stop and inform the user instead of overwriting it.

2. Draft the release notes following the **GitHub Release ノートテンプレート** in
   `docs/03-release-skill-design.md` (with real measured verification results and links to PRs).

### Confirmation Gate 4 — Approve GitHub Release

Present the exact release title (`v${TARGET_VER}`) and full release notes text to the user and ask
for explicit approval.

After approval:

```bash
gh release create "v${TARGET_VER}" \
  --title "v${TARGET_VER}" \
  --notes-file /tmp/statusline-release-notes.md
```

---

## Rules That Hold Throughout

- **Never run local publish commands** (`npm publish`, `bun publish`, `pnpm publish`, `yarn publish`,
  `yarn npm publish`). Publishing happens exclusively through `.github/workflows/publish.yml` (OIDC).
- **Never skip any of the 4 confirmation gates** (version confirmation, PR merge, tag push, GitHub
  Release creation).
- **Never tag a non-`main` branch, unmerged PR commit, dirty tree, or mismatched `package.json`.**
- **Never force-push or delete/overwrite existing release tags.**
- **Never touch the real `~/.claude/settings.json` or `~/.gemini/antigravity-cli/settings.json`.**

## When You Are Done

Report a concise summary to the user containing:
- Released version & tag (`vX.Y.Z`)
- Version-bump PR URL
- `publish.yml` workflow run URL
- Verified npm package version (`@chieeeeno/claude-statusline@X.Y.Z`)
- GitHub Release URL
