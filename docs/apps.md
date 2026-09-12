# Design note: apps (non-repo process members)

Status: draft. Working name `apps` (see [Naming](#naming)).

## Problem

Every member of a multree group is a git worktree. But real dev groups often
need a **sidecar process that has no source tree you develop in the group**: a
local mail sink, a mock payments/SMS/OAuth service, object storage, a tunnel, a
stub API. These are run from a published binary or image, not checked out and
edited alongside the feature.

Today there are only two ways to bring one into a group, and both are wrong:

- **Model it as a repo.** Forces a clone and a worktree for something you only
  run (e.g. via a published CLI), and it breaks outright for anyone in the group
  who does not have that clone. A repo carries `branch_base`, `prime_artifacts`,
  `push`, update/checkout semantics that make no sense for a process.
- **Bolt a `run` command onto an unrelated repo.** The process gets no identity,
  no allocated ports, no `exposes`/`consumes` wiring, no presence-gating, and no
  cmux pane, and it writes stray files into that repo's worktree (git noise,
  manual cleanup).

The gap is a **first-class member that participates in the variables / exposes /
consumes / cmux / `--include` machinery exactly like a repo, but is backed by a
per-group scratchpad directory instead of a git worktree, and is launched from a
command rather than checked out.**

## Concept

A new top-level `apps:` map, sibling to `repos:`. An app is a group member with
no source tree.

- On create/add, multree makes `<worktree_root>/<group>/<app-name>/` — a plain
  directory that is the app's scratchpad and its run/hook cwd. On destroy/remove
  it is deleted. No `git` is ever invoked for an app.
- Apps are added to `group.members` just like repos, so `buildContext`,
  `assignGroupVariables`, `wireGroup`, `depends_on` ordering, and the cmux pane
  layout all operate over them unchanged — a member is a member.
- Apps are includable via `--include` and `default_include`. An app name must be
  unique across all repos **and** apps in a group (members are addressed flat,
  as run/command targets already are).

## What an app has, and does not have

| Field | Repo | App | Notes |
|---|---|---|---|
| `variables` | yes | yes | port allocation, identical ledger + semantics |
| `exposes` | yes | yes | publish a value other members consume |
| `consumes` | yes | yes | still available for apps whose binary reads a dotfile |
| `env` | — | **yes (new)** | resolved vars injected straight into the run process |
| `run` / `commands` | `commands` only | `run` primary + optional `commands` | the service command(s) |
| `depends_on` | yes | yes | e.g. app depends_on a repo for `{api.port}` |
| `cmux` pane | yes | yes | service pane by default (it has `run`) |
| `hooks.setup` / `teardown` | yes | yes | run in the scratchpad dir |
| `path` | required | — | scratchpad dir is derived, not declared |
| `branch_base` | yes | — | no git |
| `prime_artifacts` | yes | — | no source tree to prime |
| `push` / `update_strategy` / `main_checkout_action` | yes | — | no git |
| `hooks.install` | yes | — (optional) | no deps to install; keep only if a real use case appears |

## App-specific ergonomics

Two simplifications that the repo path cannot offer, because multree launches
the process itself:

1. **Direct `env:` injection.** An app declares `env:` as a templated map
   (`{member.key}` tokens, same resolver as `consumes`). multree resolves it and
   sets the vars directly in the run process's environment. No dotfile is
   written and no `set -a; . ./.env` dance is needed. `consumes` (which writes a
   managed block into a file) stays available for the minority of apps whose own
   binary insists on reading a config/dotfile.

2. **Built-in presence token.** multree exposes `{<member>.included}` = `"true"`
   when the member is in the group and `""` otherwise (an explicit
   `defaults.included` may override the absent value). This lets a consumer gate
   on presence without today's marker-file pattern (an app writing a file in a
   setup hook purely so another member can read it back via `exposes`). Natural
   to generalise to repos too, since presence is structural.

## Scratchpad directory

`<worktree_root>/<group>/<app-name>/`, created on add/create, removed on
destroy/remove. It is the cwd for the app's `run`, `commands`, and hooks, and the
home for anything the app writes (a data dir, logs, a dotfile from `consumes`).
Because it is outside every repo worktree, an app never dirties a repo's git
status, and cleanup is automatic when the group is destroyed.

## Wiring integration

- Variable allocation is unchanged: apps declare `variables.<name>` (currently
  `type: number` ranges), allocated from the home-level ledger. Internally the
  ledger key `(profile, group, repo, variable)` becomes
  `(profile, group, member, variable)` — a rename, not a behaviour change;
  uniqueness and freeing on remove/destroy are identical.
- `exposes` reads from a file in the scratchpad; `consumes` writes a managed
  block into a scratchpad file; `env` is injected at launch. All three resolve
  through the same template context as repos.
- `depends_on` works across the repo/app boundary in both directions. The
  important pattern: a **repo's** `consumes` references an app's exposed value,
  variable, or `{<app>.included}` token; when the app is not in the group those
  fall back to `defaults`, so the repo's env is unchanged. That is how a repo can
  auto-wire to a sidecar only when the sidecar is included — clean, teammate-safe
  opt-in with no manual edits.

## Run and lifecycle

`multree run <group> <app>` runs the app's `run` in the scratchpad cwd with the
resolved `env` injected, in the foreground with inherited stdio (the same model
as repo command targets via `runForeground`). An optional `commands` map gives
extra verbs (`multree <verb> <group> <app>`), dispatched exactly as repo
commands are.

Non-goal: multree does not supervise the process (no health checks, no restart,
no daemonisation). The lifecycle is the foreground run or the cmux pane. Keeping
this out is what keeps apps a thin, generic addition rather than a process
manager.

## cmux integration

An app declares a `run`, so under the existing pane rule ("`service` if the
member has a run command, else `shell`") it gets a **service pane by default**,
launched in its scratchpad. So `multree create <group> --include api,<app>`
boots the app on the right alongside the repo panes — the motivating request.
`cmux.panes.<app>` accepts the same `service` / `shell` / `skip` override as
repos.

## Worked example (domain-neutral)

A `mailcatcher` sidecar wired to an `api` repo. The app claims two per-group
ports, is launched from a published binary with env injected, and publishes its
presence. The api routes outbound SMTP to it **only when it is in the group**,
via the presence token.

```yaml
repos:
    api:
        path: ~/dev/repo-a
        hooks:
            setup: "pnpm run setup"
        exposes:
            port: { type: env_file, file: .env.local, key: API_PORT }
        defaults:
            port: 5000
        consumes:
            file: .env.local
            upsert:
                # Inert unless mailcatcher is in the group: presence token is ""
                # (falsy) when absent, "true" when present. Port falls back to the
                # app's variable default when absent.
                SMTP_ENABLED: "{mailcatcher.included}"
                SMTP_HOST: "localhost"
                SMTP_PORT: "{mailcatcher.smtp_port}"

apps:
    mailcatcher:
        # multree creates <worktree_root>/<group>/mailcatcher/ as cwd; no git.
        depends_on: [api]
        variables:
            http_port: { type: number, min: 8200, max: 8249, default: 8025 }
            smtp_port: { type: number, min: 1100, max: 1149, default: 1025 }
        env:                       # injected into the process, no file written
            UI_PORT: "{mailcatcher.http_port}"
            SMTP_PORT: "{mailcatcher.smtp_port}"
            RELAY_URL: "http://localhost:{api.port}/inbound"
            DATA_DIR: "./data"     # relative to the scratchpad cwd
        run: some-mailcatcher-cli@1.2.3
        cmux: { pane: service }
```

`multree create feat --include api,mailcatcher` allocates the ports, creates the
scratchpad, injects the env, writes api's managed block with `SMTP_ENABLED=true`
and the allocated port, and (in cmux) opens a mailcatcher service pane. A group
created with just `--include api` is byte-for-byte unchanged: `SMTP_ENABLED=""`,
`SMTP_PORT` = the `1025` default, nothing listening.

## Extension: member-contributed group-root files (e.g. `.mcp.json`)

Motivating case: agent tooling. When `tools.claude` uses `open_in: $root`, the
agent launches at the group root and only auto-discovers a `.mcp.json` there;
per-repo `.mcp.json` files are dormant. So a per-group MCP server — e.g. an app
that exposes an MCP endpoint on its own port — is only reachable if multree
writes/merges a `.mcp.json` at the group root. Nothing writes the group root
today (the group-root `CLAUDE.md` is materialised by a repo's own tooling,
write-if-missing, not by multree). Note the contrast: a static `CLAUDE.md` can be
write-once, but a member's allocated port changes across groups and can move on
rewire, so `.mcp.json` must be updated in place and removed on destroy — hence
key-ownership tracking below, not write-if-missing.

Generalisation: a member (repo **or** app) declares contributions to a named
group-root file; multree merges every member's contributions into one file at
`$root`. Unlike `consumes` (per-member dotenv, sentinel-comment managed block),
this is a many-to-one JSON deep-merge into a shared file.

Surface (matches how this is being pictured):

```yaml
apps:
    mailcatcher:
        # ...ports / env / run...
        mcps:
            mailcatcher:
                type: http
                url: "http://localhost:{mailcatcher.http_port}/mcp"
```

- **Merge semantics.** Every `mcps:` block in the group merges into
  `$root/.mcp.json` under `mcpServers`, keyed by server name. multree owns only
  the keys it wrote — tracked in `GroupState`, since JSON carries no sentinel
  comments — so create/rewire update in place, destroy removes them, and hand
  edits to other keys are preserved.
- **Interpolation.** Reuse the existing `{member.var}` template engine (not shell
  `${...}`), so an mcps url can reference any member's exposed vars — one syntax
  across `env` / `consumes` / `mcps`.
- **Writer.** A new JSON deep-merge writer sits beside `env.ts` (which does
  dotenv), e.g. `json.ts`, doing deep-merge plus key-ownership tracking.

**Including the member repos.** The sibling repo worktrees (and app scratchpads)
are immediate subdirectories of `$root`, so they are already in scope for a
session launched there: their files are accessible without any
`permissions.additionalDirectories` entry (that key is only for directories
*outside* the cwd tree), and each subdir's `CLAUDE.md` loads on demand when Claude
reads a file under it. What is NOT inherited is per-subdirectory config: only the
group root's `.claude/settings.json` applies to the session, and a member repo's
own checked-in `.mcp.json` is dormant at the group root. So "include the repos"
is not a directory-list problem — it means hoisting each member's declared MCP
servers up into the merged `$root/.mcp.json` (and enabling them in the group-root
settings). The merge writer should therefore also read each member worktree's
`.mcp.json` and fold its `mcpServers` in, alongside the manifest `mcps:` blocks —
with the caveat that a member's `stdio` server can carry repo-relative paths that
need resolving when hoisted, whereas `http` servers hoist cleanly.

**Staying generic.** Implement it as a group-root JSON-merge writer; `.mcp.json` /
`mcpServers` are an ecosystem convention (MCP is an open protocol), acceptable as
a recognised feature the same way the manifest already names a `claude` tool. Do
not hardcode any project's paths, ports, or names in `src/`.

**Trust (more coupled, opt-in).** A project `.mcp.json` server is not called until
approved, so every new group would prompt. multree could also manage a group-root
`.claude/settings.json` with `enabledMcpjsonServers` limited to the servers it
wrote. That is Claude-Code-specific, so it belongs behind an explicit manifest
opt-in rather than baked in, and it carries a security implication: auto-enabling
means a new group trusts those servers without a prompt. Safe when they are
servers multree itself declared from the user's own manifest; still a conscious
opt-in.

The exact keys are top-level in `.claude/settings.json`: `enabledMcpjsonServers`
(array of server names) or `enableAllProjectMcpServers` (boolean). Important
caveat (Claude Code v2.1.196+): a committed approval is **ignored in an untrusted
folder** until the user accepts the workspace-trust dialog, and every fresh group
root is a new, untrusted folder. So writing these keys does not by itself
guarantee a promptless first `/mcp` call — multree would additionally need to mark
the group root trusted (if Claude Code exposes that) to fully skip the dialog.
Treat "no prompt on first call" as best-effort until that path is confirmed.

This extension is independent of the core apps wiring and can land as its own
phase; it applies to `repos:` as well as `apps:`.

## Workspace conveniences (`claude_workspace`) — implemented

A top-level opt-in block, both fields default off (so the block's absence is the
current behaviour):

```yaml
claude_workspace:
    hoist_member_mcps: true     # fold each repo member's own .mcp.json into $root/.mcp.json
    additional_directories: true # write $root/.claude/settings.json permissions.additionalDirectories
```

Why each exists, from the Claude Code docs:

- **MCP discovery is launch-dir only.** Claude discovers `.mcp.json` at the cwd
  (plus user `~/.claude.json` and managed/enterprise scopes) and **never** in
  subdirectories. So when `multree claude` opens at the group root, a sub-repo's
  own `.mcp.json` servers are invisible. `hoist_member_mcps` reads each repo
  member's `<worktree>/.mcp.json` and folds its `mcpServers` into the merged
  group-root `.mcp.json` (manifest `mcps:` win on a name collision). A hoisted
  `stdio` server with a relative `command` is rewritten to an absolute path
  against its worktree, and its `cwd` defaults to that worktree, so it still
  launches from the group-root cwd; `http`/`sse` servers are untouched. Hoisted
  servers join the existing `mcp_servers` ownership, so rewire/destroy clean them
  up like manifest-contributed ones.
- **`additionalDirectories` grants file access, not configuration.** The docs are
  explicit that `.mcp.json` is not loaded from additional directories — it only
  extends where Claude can read/edit files (it does pick up those dirs' skills,
  commands and subagents). But inherited folder-trust **excludes nested git
  repos**, and the member worktrees are nested git repos under the group root, so
  `additional_directories` writes a group-root `.claude/settings.json` listing each
  repo member's worktree under `permissions.additionalDirectories` to grant that
  access. Apps are plain subdirectories already covered, so only repo members are
  listed. The file lives in the group dir (removed wholesale on destroy); the
  writer merges, owns only the paths it added, and preserves foreign entries.

Both write ONLY inside the group dir (and the group-root `.mcp.json`). Neither
touches `~/.claude.json`, workspace trust, or MCP approval state — so like any
project `settings.json`, they take effect only once the group root is trusted
(a one-time `cd <worktree_root> && claude` covers every group for interactive
sessions). Trust/approval automation is deliberately out of scope here (see the
Trust subsection above and decision 9).

## Proposed schema

```ts
interface AppConfig {
    variables?: Record<string, NumberVariableSpec>;
    exposes?: Record<string, ExposeSpec>;
    consumes?: ConsumeSpec | ConsumeSpec[];
    mcps?: Record<string, McpServerSpec>;    // contributes to $root/.mcp.json (repos too)
    env?: Record<string, string>;            // templated; injected at launch
    run?: string | string[];                 // primary service command
    commands?: Record<string, TargetSpec>;   // optional extra verbs
    depends_on?: string[];
    hooks?: { setup?: HookSpec; teardown?: HookSpec; timeout?: ... };
    cmux?: { pane: PaneKind | PaneKind[] };
}

interface MultreeConfig {
    // ...existing...
    repos: Record<string, RepoConfig>;
    apps?: Record<string, AppConfig>;
}
```

Most wiring code already keys off a generic member shape (`path`, `variables`,
`exposes`, `consumes`); the main new work is a member abstraction that repos and
apps both satisfy, plus scratchpad creation/removal where repos do worktree
add/remove.

## CLI / command touch points

- `create.ts` — after repo worktrees, create app scratchpads, run app `setup`
  hooks, include apps in `assignGroupVariables` + `wireGroup`.
- `destroy.ts` / `remove.ts` — app `teardown`, remove scratchpad, release ledger
  entries.
- `add.ts` — allow adding an app to an existing group.
- `list.ts` / `show.ts` / `status.ts` — render apps (no git columns; show ports
  and scratchpad path).
- `cli.ts` — `run`/verb dispatch resolves app targets; `--include` validation and
  `default_include` accept app names; completion includes them.
- `config.ts` `validate()` — `apps` schema, member-name uniqueness across repos +
  apps, `depends_on` across both, `default_include` membership.
- cmux pane-layout logic — treat an app with `run` as a service pane.

## Testing

Per CONTRIBUTING + CLAUDE conventions, every variant owes a test.

- Unit: `validate()` for `apps` (good + rejections: name clash with a repo,
  unknown `depends_on`, bad variable range); wiring over a context that includes
  an app member; the `{member.included}` presence token (present vs absent);
  `env` template resolution.
- Integration: `create --include api,app` makes the scratchpad, injects env,
  writes the consumer's managed block, allocates ports; `create --include api`
  leaves the consumer at defaults (gating); `destroy` removes the scratchpad and
  frees ports; `add` / `remove` of an app re-wire the remainder.
- Extend `tests/helpers/sandbox.ts` to plumb an app through, rather than
  hand-writing YAML in tests.

## Naming

`apps` matches how the feature was conceived and reads naturally in config and
`--include`. The quibble: repos are also "apps", so the distinction (source-
backed vs process-only member) is not in the word. `sidecars` is the most precise
alternative; `services` collides with the cmux `service` pane kind and is
overloaded. Recommendation: keep `apps` unless the repos-are-also-apps ambiguity
bites; it is a one-token rename in the schema either way.

## Phasing

- **P1 — core.** `apps` schema + `validate`; scratchpad create/destroy; hook up
  into `assignGroupVariables` / `wireGroup`; `env` injection; `{member.included}`
  token; `multree run <group> <app>`; `--include` / `default_include`; unit +
  integration tests. This alone delivers the full wiring value (committable to a
  shared manifest, auto-gated, no clone).
- **P2 — cmux.** App service panes so `--include` boots them on the right;
  `cmux.panes.<app>` override.
- **P3 — polish.** `list` / `show` / `status` rendering; completion; docs;
  `multree.config.example.yaml` entry.
- **P4 — group-root files (parallel track).** `mcps:` on members merged into
  `$root/.mcp.json` (JSON-merge writer, key-ownership in `GroupState`); optional
  opt-in `$root/.claude/settings.json` trust management. Independent of P1-P3;
  needs only the P1 member/token context. Pairs with an MCP endpoint built on the
  app side in parallel.

## Open decisions

1. `env:` direct injection vs reusing file `consumes` only. (Lean: include `env`.)
2. Built-in `{<member>.included}` token vs explicit marker-file pattern. (Lean:
   add the token.)
3. Name: `apps` vs `sidecars`. (Lean: `apps`.)
4. Single `run` vs a `commands` map. (Lean: `run` primary + optional `commands`.)
5. Do apps ever need an `install` hook? (Lean: no, until a use case appears.)
6. Rename ledger/context key `repo` → `member` now, or keep the field name and
   just document that apps reuse it. (Lean: rename for clarity.)
7. `mcps:` as a bespoke feature vs a generic group-root JSON-merge writer with
   `mcps:` as its first consumer. (Lean: generic writer, `mcps:` surface.)
8. Manage the `$root/.claude/settings.json` trust file (opt-in, scoped to
   multree-written servers) vs leave trust to the user. RESOLVED (Giles): yes —
   verified nothing writes group-root Claude settings today (only a write-if-
   missing `CLAUDE.md`), so multree generating it is net-new and non-conflicting.
   Keep it opt-in in the manifest and scoped to the servers multree wrote.
9. Promptless first call needs the group root marked *trusted*, not just the
   approval keys (committed approvals are ignored in an untrusted folder until the
   workspace-trust dialog is accepted). Confirmed: the only way to pre-trust
   without a dialog is writing `~/.claude.json` `projects[path].hasTrustDialogAccepted`
   (per-folder), or trusting a parent once (interactive sessions only; `claude -p`
   / SDK do not inherit parent trust). Managed settings CANNOT pre-approve project
   `.mcp.json` servers. Automating the `~/.claude.json` write is deliberately NOT
   done here (it is a trust-gate bypass); left to a one-time parent-trust.
10. RESOLVED: hoist member repos' own checked-in `.mcp.json` into the merged
    group-root `.mcp.json`, behind `claude_workspace.hoist_member_mcps` (off by
    default). Manifest `mcps:` win on collision; a hoisted `stdio` server's
    relative `command` is absolutized against its worktree with `cwd` defaulted
    there; `http`/`sse` untouched. This is required because MCP discovery is
    launch-dir only and `additionalDirectories` does not load subdir `.mcp.json`.
```
