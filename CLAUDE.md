# multree

Multi-repo `git worktree` group orchestrator. Creates linked worktrees across N repos, runs per-repo install/setup/teardown hooks, primes heavy artifacts (e.g. `node_modules`) via APFS reflinks, and wires consumer repos' env files to expose values (such as a server port) produced by other repos in the same group.

## Toolchain — read first

- **Package manager: pnpm.** This is a pnpm workspace (`pnpm-workspace.yaml`, `pnpm-lock.yaml`).
- **Never use `npx` in this repo.** Not for installs, not for running binaries, not for one-off scripts. If a binary needs running, invoke it via the local `node_modules/.bin/` entry, a `package.json` script (`pnpm <script>`), or `pnpm exec <bin>`. `npx` will pull a global cache, can resolve a different version than the lockfile, and bypasses the workspace — assume it is forbidden.
- **Node**: requires `>=20.6` (see `package.json` `engines`). The `bin/multree` shim relies on `tsx` from local `node_modules/.bin`.
- **TypeScript runner**: `tsx`. No build step — source runs directly. The CLI entry is `src/cli.ts`, invoked through `bin/multree`.

## Commands

Run scripts via pnpm:

- `pnpm typecheck` — `tsc --noEmit` against `src/**/*.ts` and `tests/**/*.ts`.
- `pnpm dev` — run the CLI (`tsx src/cli.ts`).
- `pnpm test` — unit + integration via the built-in node test runner (`tsx --test`).
- `pnpm test:unit` — `tests/unit/*.test.ts` only (pure modules, ~0.5s).
- `pnpm test:integration` — `tests/integration/*.test.ts` only (spawn the real `bin/multree` against sandboxed fixture repos through `tests/helpers/cli.ts` and `sandbox.ts`; ~7s).

The installed CLI symlink is `~/.local/bin/multree -> bin/multree`. Invoke `multree <subcommand>` for end-to-end behaviour against the real manifest.

### pnpm preinstall gotcha

pnpm 11 runs a deps-status check before every `pnpm <script>` invocation, which triggers an implicit `pnpm install`. That install fails with `ERR_PNPM_IGNORED_BUILDS` because `esbuild` has a postinstall build script that hasn't been approved. Two ways past it:

- One-off fix: `pnpm approve-builds` and accept esbuild. This unblocks every `pnpm <script>` call thereafter.
- Bypass route (when you can't / don't want to approve builds): call `tsx` directly against the local binary — `./node_modules/.bin/tsx --test tests/unit/*.test.ts` (or `tests/integration/*.test.ts`, or both globs). This skips the deps check and runs the exact same command `package.json` declares.

Never substitute `npx tsx` here — see the toolchain rules above.

## Repo layout

```
src/
  cli.ts            # argv parsing + subcommand dispatch (also routes tool subcommands)
  config.ts         # YAML manifest loader + validator, path expansion, branch_base resolution
  types.ts          # shared types: MultreeConfig, GroupState, HookSpec, ConsumeSpec, etc.
  state.ts          # per-group state file (.multree.json) read/write + group dir resolution
  git.ts            # fetch / worktree add / worktree remove wrappers around `git`
  hooks.ts          # normalise HookSpec, run install/setup/teardown shell commands
  artifacts.ts      # prime_artifacts: copy or APFS reflink (cp -c) a path / find-by-basename
  env.ts            # parse + upsert managed-block env files (multree-managed sentinel comments)
  wiring.ts         # read exposes from each member, template + write consumes blocks
  tools.ts          # generic tool dispatch (e.g. `multree claude <group>`, `multree code <group>`)
  commands/
    create.ts       # create group: worktree + prime + install + setup, then wire
    add.ts          # add a repo to an existing group, then re-wire the whole group
    remove.ts       # teardown a member, drop from state, re-wire remainder
    destroy.ts      # teardown all members, remove worktrees, delete group dir
    list.ts         # enumerate groups under worktree_root
    show.ts         # print a single group's state
    rewire.ts       # re-read exposes, re-apply consumes (no worktree changes)
tests/
  unit/             # env block parsing, wiring template substitution
  integration/      # full command flows against fixture repos
  fixtures/repos/   # tiny git repos used by integration tests
  helpers/          # shared test scaffolding
bin/multree                  # bash shim that execs tsx on src/cli.ts
multree.config.example.yaml  # committed example manifest; user copies it to ~/multree.config.yaml
```

## Concepts

- **Manifest** (`~/multree.config.yaml` by default, or wherever `$MULTREE_CONFIG` points): user-owned, lives outside the repo. The repo only commits `multree.config.example.yaml`. Versioned (`version: 1`). Declares `worktree_root`, `repos`, and `tools`. Loaded by `loadConfig()`.
- **Group**: a named set of worktrees living at `<worktree_root>/<group-name>/`. Persistent state is `<worktree_root>/<group-name>/.multree.json` (`GroupState` in `types.ts`).
- **Hook phases**, in order, per repo on add/create: `prime_artifacts` → `install` → `setup`. `teardown` runs on remove/destroy. A hook is either a bare string (runs in the worktree) or `{ command, cwd: "worktree" | "repo" }`.
- **exposes / consumes wiring**: a repo can `expose` a value read from one of its env files after setup (e.g. an api server's chosen port). Other repos `consume` that value by referencing `{<repo>.<key>}` in `consumes.upsert`, which is written into the consumer's env file inside a managed block bracketed by `# >>> multree-managed: <group> >>>` / `# <<< multree-managed: <group> <<<`. `defaults` provide fallback values when the producing repo isn't part of the group. Re-running `rewire` is idempotent — the managed block is replaced wholesale, never appended.
- **prime_artifacts**: each entry has either `path` or `find` (basename to locate recursively in the source repo), and a `strategy` (`copy` or `reflink`). Reflink uses `cp -c` (APFS clone) so trees like `node_modules` are reconciled rather than cold-installed.
- **tools dispatch**: any `tools.<name>` block in the manifest becomes `multree <name> <group>`. `open_in` is a preference chain — `$root` is the group folder; otherwise a repo key. `command` is either a shell string or an argv array, with `{cwd}` substituted.

## Working conventions

- Strict TS, ES2022, `module: ESNext`, `moduleResolution: Bundler`, `allowImportingTsExtensions: true`. All intra-`src` imports use `.ts` extensions — preserve this.
- One concern per file. New subcommands go under `src/commands/<name>.ts` and are wired into `BUILTIN_COMMANDS` and the switch in `src/cli.ts`.
- Side-effecting filesystem / shell logic lives in `git.ts`, `hooks.ts`, `artifacts.ts`, `env.ts`. Keep `commands/*.ts` as orchestrators that call these — don't inline new `execSync` or `fs` calls into commands.
- Validation errors throw; `main()` in `cli.ts` prints `err.message` and exits 1. Don't swallow exceptions further down the stack.
- Path expansion (`~/`) goes through `expandPath` in `config.ts`. Don't hand-roll tilde handling elsewhere.
- Branch base resolution goes through `resolveBranchBase` — per-repo `branch_base`, falling back to `origin/main`.
- Tests use the node built-in test runner via `tsx --test`. Unit tests cover pure modules (`env`, `wiring`); integration tests drive whole subcommands against fixture repos in `tests/fixtures/repos/`.
- The manifest is the source of truth for behaviour. Prefer extending it (new hook phase, new expose type, new tool block) over hardcoding repo-specific logic in source.
