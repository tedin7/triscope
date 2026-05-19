# Contributing to Triscope

Thanks for taking a look. The project is in early-stage active
development; the API surface is settling but not frozen. Issues and PRs
are welcome — read this once and you should be good.

## Repo layout

Monorepo, npm workspaces. The four publishable packages live under
`packages/`:

- `@triscope/core` — Element contract + harness + Vite plugin
- `@triscope/cli` — the `triscope` binary
- `@triscope/mcp` — MCP server for live AI control
- `create-triscope` — `npm init triscope <dir>` scaffolder

A runnable reference scene lives at `examples/ocean-galleon`.

## Local setup

You need **Node 20+** and a recent Chromium build on `PATH`
(`chromium` on Linux, `Google Chrome.app` on macOS, `chrome.exe` on
Windows — see [`README.md`](./README.md) for the env vars).

```bash
git clone https://github.com/tedin7/triscope.git
cd triscope
npm install
npm run build --workspace=@triscope/core   # produces .d.ts for downstream
```

## The dev loop

```bash
# Type-check everything
npm run typecheck

# Unit tests (vitest, all four workspaces)
npm test

# Unit tests + coverage report (text + html under each package's coverage/)
npm run test:coverage

# Watch mode in one package
npm test:watch --workspace=@triscope/core
```

The headed end-to-end smoke needs a real Chromium and a display
(or xvfb on Linux):

```bash
xvfb-run --auto-servernum --server-args='-screen 0 1280x720x24' \
  npm run smoke --workspace=@triscope/example-ocean-galleon
```

CI runs both jobs on every PR (`.github/workflows/ci.yml`). A PR that
red-lights either job won't be merged.

## Code style — what we don't do

- **No spurious abstractions.** Three repeated lines is fine. Wait
  for a fourth before extracting.
- **No comments that describe what the code does.** Only the *why* —
  hidden constraints, workarounds for specific bugs, behaviour a
  future reader would otherwise misinterpret.
- **No try/catch around `process.exit`** (or any other branch that
  should never silently swallow). Catch only the call that can
  plausibly throw.
- **No tests that assert `typeof === 'function'`.** Exercise observable
  behaviour. If a test doesn't fail when you intentionally break the
  feature it's testing, it's not earning its place.

## Adding tests

Drop new test files under the relevant package's `test/` directory.
Vitest picks them up automatically from the include pattern in each
`vitest.config.{ts,mjs}`.

- Pure-Node tests: keep `environment: 'node'` (the default).
- DOM tests: add `// @vitest-environment jsdom` at the top of the file.
- End-to-end behaviour: prefer a subprocess test invoking the bin
  (`spawnSync(process.execPath, [BIN, ...])`) over a mock of the
  helper layer.

Some modules have intentionally narrow unit-test coverage because
their real exercise lives in the smoke job (`harness.ts`, `server.ts`,
`createBrowserPool`). Those files are explicitly excluded from
coverage in each `vitest.config`; if you add new logic to them,
either cover it in the smoke (preferred) or extract the pure parts
into helpers that can be unit-tested.

## Commit messages

Conventional-ish prefixes (`feat:`, `fix:`, `test:`, `docs:`,
`ci:`, `chore:`). Short subject (under ~72 chars), then a body
that explains the *why*. Look at `git log` for the house style.

## Branches and PRs

- Branch from `main`. Name it after the change, not the bug
  number (`fix/inspect-overlay-flicker`, not `pr-42`).
- Keep commits self-contained where you can — one logical change
  per commit beats a single 30-file mega-commit.
- The CI gate above is the bar; if it's green and a maintainer signs
  off, your PR is merged.

## Release process (for maintainers)

Releases are tagged on `main`. `npm publish --workspaces` from a
clean checkout after tagging — see
[`.github/workflows/release.yml`](./.github/workflows/release.yml).
The `CHANGELOG.md` is updated as part of the release commit.
