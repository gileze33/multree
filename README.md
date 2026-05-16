# multree

Multi-repo `git worktree` group orchestrator. Creates linked worktrees across N repos for a named group, runs per-repo install/setup/teardown hooks, and wires consumer repos' `.env` files to expose values (such as a server port) produced by other repos in the same group.

## Install

```bash
cd <multree-checkout>
pnpm install
mkdir -p ~/.local/bin && ln -sf "$PWD/bin/multree" ~/.local/bin/multree
multree --help
```

(Make sure `~/.local/bin` is on `$PATH`.) Requires Node 20.6+.

## Configure

`multree` reads a manifest YAML from, in order:

1. `$MULTREE_CONFIG` if set
2. `~/multree.config.yaml`

Start by copying the example into your home directory:

```bash
cp multree.config.example.yaml ~/multree.config.yaml
$EDITOR ~/multree.config.yaml
```

The repo only commits `multree.config.example.yaml`; a personal `~/multree.config.yaml` lives outside the repo so the tool stays generic.

### Manifest shape

- `worktree_root` — parent for all groups. Each group becomes `<worktree_root>/<group-name>/`, with each repo checked out at `<worktree_root>/<group-name>/<basename-of-repo-path>/`.
- `repos.<name>.path` — absolute path (supports `~/`) to the main checkout.
- `repos.<name>.branch_base` — ref to branch from (default `origin/main`).
- `repos.<name>.hooks.install/setup/teardown` — shell command run in the new worktree (or `cwd: repo` for the main checkout).
- `repos.<name>.exposes.<key>` — read a value from the new worktree's env file after setup. Other repos reference it as `{<repo>.<key>}` in their `consumes.upsert`.
- `repos.<name>.consumes.upsert` — env keys to write into the new worktree's env file. Values are templated against the exposes context.
- `repos.<name>.defaults.<key>` — fallback value when the repo isn't part of the group (e.g. point frontends at default api port `5000` when api isn't selected).
- `repos.<name>.prime_artifacts` — APFS reflink trees like `node_modules` from the main checkout into the new worktree so install reconciles instead of cold-installing.

Env wiring is bracketed by `# >>> multree-managed: <group> >>>` / `# <<< multree-managed: <group> <<<` so repeated `rewire` calls don't leak.

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
```

`create` makes a worktree per included repo, runs each `install` and `setup` hook, reads `exposes`, then upserts each `consumes` block.

`add` brings a new repo into an existing group (worktree + setup hook on the group's branch), then re-wires the whole group so its exposes reach existing consumers.

`remove` runs the repo's `teardown` hook, removes its worktree, drops it from group state, and re-wires the remainder so consumers fall back to defaults.

`rewire` re-reads exposes and re-applies consumes. Use after editing the manifest or if env files drift.

`destroy` runs `teardown` hooks, removes the worktrees, then deletes the group folder. The branch is left in place; delete via `git branch -d` once merged.

Any `tools.<name>` block in the manifest becomes `multree <name> <group>`.
