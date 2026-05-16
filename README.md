# multree

**Multi-repo `git worktree` group orchestrator.** Spin up a coordinated set of worktrees across N repos for a single feature branch, run each repo's install/setup/teardown hooks, prime heavy artifacts (e.g. `node_modules`) via APFS reflinks, and auto-wire consumer repos' env files to values produced by other repos in the same group (such as a server port chosen at setup time).

## Why

If you work across several repositories that talk to each other in dev — say an API, a web frontend, and a worker — every new feature branch costs you a chain of fiddly setup: clone-or-pull each repo, switch branches, reinstall dependencies, hand-edit `.env` files so the frontend points at the API's port, remember to tear it all down later. `git worktree` solves the checkout half of that, but it's per-repo and knows nothing about your install steps or how your repos depend on each other at runtime.

`multree` adds a layer on top: a single declarative manifest of your repos, hooks, and inter-repo env wiring. One command (`multree create feature-x --include api,frontend`) produces a self-contained group folder with a worktree per repo, dependencies installed, env files glued together, ready to run. One command (`multree destroy feature-x`) takes it all back down again.

It also reflinks `node_modules` from the main checkout on macOS via `clonefile(2)`, so creating a fresh worktree costs seconds rather than minutes.

## Platform support

Tested on macOS (where reflinks use APFS `clonefile`) and Linux (where reflinks use GNU `cp --reflink=auto` on btrfs/xfs/bcachefs, falling back to a regular copy elsewhere). Windows is not supported.

## Install

From npm (recommended):

```bash
npm i -g multree-cli
multree --help
```

Requires Node 20.6+.

From source (for contributors):

```bash
git clone https://github.com/gileze33/multree.git
cd multree
pnpm install
mkdir -p ~/.local/bin && ln -sf "$PWD/bin/multree" ~/.local/bin/multree
multree --help
```

Make sure `~/.local/bin` is on `$PATH`. Requires Node 20.6+ and pnpm.

## Configure

`multree` reads a manifest YAML from, in order:

1. `$MULTREE_CONFIG` if set
2. `~/multree.config.yaml`

Start by copying the example into your home directory:

```bash
cp multree.config.example.yaml ~/multree.config.yaml
$EDITOR ~/multree.config.yaml
```

The repo only ships `multree.config.example.yaml`; your personal `~/multree.config.yaml` lives outside the repo so the tool stays generic.

### Manifest shape

- `worktree_root` — parent for all groups. Each group becomes `<worktree_root>/<group-name>/`, with each repo checked out at `<worktree_root>/<group-name>/<basename-of-repo-path>/`.
- `repos.<name>.path` — absolute path (supports `~/`) to the main checkout.
- `repos.<name>.branch_base` — ref to branch from (default `origin/main`).
- `repos.<name>.hooks.install/setup/teardown` — shell command run in the new worktree (or `cwd: repo` for the main checkout). Each hook can also be `{ command, cwd, timeout }`; `timeout` accepts `"5m"`, `"30s"`, `"500ms"`, or a bare number (seconds).
- `repos.<name>.hooks.timeout` — default timeout for this repo's hooks; overridden by per-hook `timeout`.
- `repos.<name>.depends_on` — list of other repo keys whose `setup` must complete before this repo's `setup` starts. Cycles are rejected at config load.
- `repos.<name>.exposes.<key>` — read a value from the new worktree's env file after setup. Other repos reference it as `{<repo>.<key>}` in their `consumes.upsert`.
- `repos.<name>.consumes.upsert` — env keys to write into the new worktree's env file. Values are templated against the exposes context.
- `repos.<name>.defaults.<key>` — fallback value when the repo isn't part of the group (e.g. point frontends at default dev port `5000` when the api isn't selected).
- `repos.<name>.prime_artifacts` — APFS-reflink (macOS) or `--reflink=auto` (Linux) large trees like `node_modules` from the main checkout into the worktree so install reconciles instead of cold-installing.
- `repos.<name>.update_strategy` — `rebase` or `merge`; overrides the manifest-level default for `multree update`.
- `repos.<name>.push` — set `false` to skip this repo in `multree push`. Defaults to `true`.
- `update_strategy` (top-level) — default strategy used by `multree update` when neither a per-repo override nor `--strategy` is given. Defaults to `rebase`.
- `main_checkout_action` (top-level, also per-repo) — what to do when a target branch is already checked out in a repo's main source. `switch` (default) moves the main checkout onto its `branch_base` (with any leading `origin/` stripped), `detach` leaves it on a detached HEAD, `error` refuses to act. Pre-flight aborts the whole `create` (no half-built groups) if any repo's plan can't be satisfied — including dirty main checkouts, branches held by other worktrees, or `--from` branches that don't exist.
- `jobs` (top-level) — default concurrency cap for `create`'s prime/install phases (and `setup` when `parallel_setup` is set). Overridden by `--jobs N` on the CLI; defaults to the host's CPU count.
- `parallel_setup` (top-level) — run the `setup` phase in parallel up to `jobs`, respecting `depends_on`. Defaults to `false` (setup runs serially because it often touches shared resources).
- `hook_timeout` (top-level) — default timeout for any hook in any repo, overridden by per-repo `hooks.timeout` and per-hook `timeout`.

Env wiring is bracketed by `# >>> multree-managed: <group> >>>` / `# <<< multree-managed: <group> <<<` so repeated `rewire` calls don't leak.

## Worked example

With an `api` and `frontend` repo declared in your manifest (see [`multree.config.example.yaml`](./multree.config.example.yaml) for the full shape, including `exposes`/`consumes` wiring), run:

```bash
multree create feature-x --include api,frontend
```

…and you get:

```
~/dev/worktree/feature-x/
├── .multree.json          # group state
├── api/                   # worktree of your api repo on branch feature-x
│   ├── node_modules/      # APFS-cloned from the main checkout
│   └── .env.local         # contains API_PORT=51234 after the setup hook
└── frontend/              # worktree of your frontend repo on branch feature-x
    ├── node_modules/
    └── .env.local         # contains a managed block with API_URL=http://localhost:51234
```

`feature-x/frontend/.env.local` looks like:

```dotenv
# >>> multree-managed: feature-x >>>
API_URL=http://localhost:51234
# <<< multree-managed: feature-x <<<
```

When you're done:

```bash
multree destroy feature-x
```

…runs every `teardown` hook, removes the worktrees, and deletes the group folder. The branch is left in place — delete it with `git branch -d feature-x` once merged.

## Layout

```
<worktree_root>/
  <group-name>/
    .multree.json         # group state -- listed by `multree list`
    <repo-a-basename>/    # one worktree per included repo
    <repo-b-basename>/
```

## Commands

```
multree create <name> --include <repo,repo,...> [--branch <branch>] [--from <branch>] [--from-<repo> <branch> ...]
                                                [--jobs <N>] [--plan] [--resume] [--verbose]
multree add <name> <repo> [--verbose]
multree remove <name> <repo>
multree list
multree show <name>
multree status <name> [--fetch]
multree update <name> [--strategy rebase|merge]
multree push <name> [--set-upstream]
multree rewire <name>
multree destroy <name>
multree --version
multree --help
```

`create` makes a worktree per included repo, runs each `install` and `setup` hook, reads `exposes`, then upserts each `consumes` block. `--branch` names the new feature branch (defaults to `multree/<name>`). `--from <branch>` instead bases every member's worktree on an existing local or remote branch — useful for opening a colleague's PR locally as a group. `--from-<repo> <branch>` overrides the branch for a specific member (when branch names differ across repos).

Hooks run phase-by-phase across all members: `prime_artifacts` → `install` → `setup`. The first two phases are parallelised up to `--jobs N` (default = CPU count); `setup` runs serially by default but can be parallelised via the manifest's `parallel_setup`. Inter-repo dependencies declared with `depends_on` force a member's `setup` to wait for its prerequisites' `setup` to complete. Per-phase progress is persisted to `.multree.json`; if a hook fails, re-run with `--resume` to pick up from the failed phase. `--plan` prints the schedule without executing. `--verbose` streams each hook's stdout/stderr live (prefixed with the repo key); the default captures output and only surfaces it on failure.

`add` brings a new repo into an existing group (worktree + setup hook on the group's branch), then re-wires the whole group so its exposes reach existing consumers.

`remove` runs the repo's `teardown` hook, removes its worktree, drops it from group state, and re-wires the remainder so consumers fall back to defaults.

`status` prints a per-member snapshot: current branch, ahead/behind vs `branch_base`, dirty/clean, last commit, currently exposed values, and the resolved consume targets. `--fetch` runs `git fetch` in each source repo first so the ahead/behind numbers reflect the latest remote state.

`update` fetches each member's source repo, then rebases or merges that repo's `branch_base` into the member's branch. Strategy precedence: `--strategy` flag → per-repo `update_strategy` → manifest-level `update_strategy` → `rebase`. Members with a dirty working tree are skipped and reported at the end. If a rebase or merge fails the operation is aborted in that worktree (no half-applied state) and the command exits non-zero.

`push` pushes every member's current branch to `origin`, automatically applying `--set-upstream` on first push. Repos with `push: false` in the manifest are skipped (use for read-only mirrors). Any failed push surfaces in the summary and exits non-zero.

`rewire` re-reads exposes and re-applies consumes. Use after editing the manifest or if env files drift.

`destroy` runs `teardown` hooks, removes the worktrees, then deletes the group folder.

Any `tools.<name>` block in the manifest becomes `multree <name> <group>` — e.g. `multree code feature-x` opens the group in your editor.

## Update notifications

multree checks the npm registry every few hours for a newer published version and, on the next run, prints a one-line notice to stderr if you're behind:

```
[multree] new version available: 0.1.1 → 0.2.0 (run: npm i -g multree-cli@latest)
```

The check is **notify-only** — multree never auto-updates itself. The actual registry fetch happens in a detached background process so it never adds latency to your command. The result is cached in `$XDG_CACHE_HOME/multree/version-check.json` (or `~/.cache/multree/version-check.json`).

The notice is suppressed when any of the following is true:

- `CI` env var is set (truthy)
- stderr is not a TTY (output is being piped)
- `MULTREE_NO_UPDATE_CHECK=1` is set

To disable update checks permanently, add `export MULTREE_NO_UPDATE_CHECK=1` to your shell profile.

## Development

```bash
pnpm typecheck
pnpm lint
pnpm test                # unit + integration
pnpm test:unit           # ~0.5s
pnpm test:integration    # ~7s, spawns the real CLI against fixture repos
```

### Troubleshooting

**`ERR_PNPM_IGNORED_BUILDS` on any `pnpm <script>` call.** pnpm 11 runs a deps-status check before every script, which triggers an implicit install and trips on `esbuild`'s postinstall (a transitive dev dep of `tsx`). Fix once with `pnpm approve-builds`, or sidestep entirely by calling the binary directly: `./node_modules/.bin/tsx --test tests/unit/*.test.ts`.

## License

MIT — see [LICENSE](./LICENSE).
