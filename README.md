# multree

**Multi-repo `git worktree` group orchestrator.** Spin up a coordinated set of worktrees across N repos for a single feature branch, run each repo's install/setup/teardown hooks, prime heavy artifacts (e.g. `node_modules`) via APFS reflinks, and auto-wire consumer repos' env files to values produced by other repos in the same group (such as a server port chosen at setup time).

## Why

If you work across several repositories that talk to each other in dev — say an API, a web frontend, and a worker — every new feature branch costs you a chain of fiddly setup: clone-or-pull each repo, switch branches, reinstall dependencies, hand-edit `.env` files so the frontend points at the API's port, remember to tear it all down later. `git worktree` solves the checkout half of that, but it's per-repo and knows nothing about your install steps or how your repos depend on each other at runtime.

`multree` adds a layer on top: a single declarative manifest of your repos, hooks, and inter-repo env wiring. One command (`multree create feature-x --include api,frontend`) produces a self-contained group folder with a worktree per repo, dependencies installed, env files glued together, ready to run. One command (`multree destroy feature-x`) takes it all back down again.

It also reflinks `node_modules` from the main checkout on macOS via `clonefile(2)`, so creating a fresh worktree costs seconds rather than minutes.

## Platform support

Tested on macOS (where reflinks use APFS `clonefile`) and Linux (where reflinks use GNU `cp --reflink=auto` on btrfs/xfs/bcachefs, falling back to a regular copy elsewhere). Windows is not supported.

## Install

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
- `repos.<name>.hooks.install/setup/teardown` — shell command run in the new worktree (or `cwd: repo` for the main checkout).
- `repos.<name>.exposes.<key>` — read a value from the new worktree's env file after setup. Other repos reference it as `{<repo>.<key>}` in their `consumes.upsert`.
- `repos.<name>.consumes.upsert` — env keys to write into the new worktree's env file. Values are templated against the exposes context.
- `repos.<name>.defaults.<key>` — fallback value when the repo isn't part of the group (e.g. point frontends at default dev port `5000` when the api isn't selected).
- `repos.<name>.prime_artifacts` — APFS-reflink (macOS) or `--reflink=auto` (Linux) large trees like `node_modules` from the main checkout into the worktree so install reconciles instead of cold-installing.

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
multree create <name> --include <repo,repo,...> [--branch <branch>]
multree add <name> <repo>
multree remove <name> <repo>
multree list
multree show <name>
multree rewire <name>
multree destroy <name>
multree --version
multree --help
```

`create` makes a worktree per included repo, runs each `install` and `setup` hook, reads `exposes`, then upserts each `consumes` block.

`add` brings a new repo into an existing group (worktree + setup hook on the group's branch), then re-wires the whole group so its exposes reach existing consumers.

`remove` runs the repo's `teardown` hook, removes its worktree, drops it from group state, and re-wires the remainder so consumers fall back to defaults.

`rewire` re-reads exposes and re-applies consumes. Use after editing the manifest or if env files drift.

`destroy` runs `teardown` hooks, removes the worktrees, then deletes the group folder.

Any `tools.<name>` block in the manifest becomes `multree <name> <group>` — e.g. `multree code feature-x` opens the group in your editor.

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
