---
name: release
description: Cut a new multree release. Bumps the version in package.json, commits, tags vX.Y.Z, and pushes — which triggers the GitHub Actions release workflow to publish to npm with provenance via OIDC trusted publishing. Use when the user says "release", "cut a release", "publish a new version", "ship a version", "bump version", or any phrasing that means producing a new published version of multree.
---

# Release a new multree version

This skill drives a clean release: pick a semver bump, run pre-publish checks, tag, push, then watch the release workflow on GitHub.

## Preconditions

Before doing anything, verify all of:

1. Working directory is the multree repo root (look for `package.json` with `"name": "multree"`).
2. Current branch is `main`.
3. Working tree is clean (`git status --porcelain` is empty).
4. Local `main` is up to date with `origin/main` (`git fetch && git rev-parse HEAD == origin/main`).
5. The release workflow exists at `.github/workflows/release.yml`.

If any precondition fails, stop and tell the user what's wrong. Do not try to "fix" by stashing, committing, or rebasing on the user's behalf.

## Bootstrap caveat (first publish only)

OIDC trusted publishing on npm requires the package to already exist in the registry, and a Trusted Publisher to be configured on npmjs.com pointing at this repo's `release.yml`.

Before running this skill for the first time, confirm with the user that:

- They have published `multree` to npm manually at least once from their laptop, having `npm login`-ed first. The bootstrap publish **must drop `--provenance`**: provenance attestation requires an OIDC-capable CI provider (GitHub Actions, GitLab CI, etc), and a local machine has none. Use `pnpm publish --access public --no-git-checks`. The package gets provenance from the first CI-driven release onwards (v0.1.1+), not from the bootstrap.
- The Trusted Publisher is configured on npmjs.com for the `multree` package against `gileze33/multree` and workflow `release.yml`.

If either is missing, the tag push will succeed but the workflow's publish step will fail. Better to surface this up front.

## Picking the bump

Ask the user which bump to apply unless they've already specified one:

- `patch` (`0.1.0 -> 0.1.1`): bugfixes, doc tweaks, internal refactors with no behavioural change.
- `minor` (`0.1.0 -> 0.2.0`): new features, new manifest fields, new subcommands. Also use for **breaking changes** while still on `0.x` (semver carves out `0.x` as "anything goes").
- `major` (`0.1.0 -> 1.0.0`): only when the user wants to commit to manifest backwards compatibility going forward.

Default discipline: stay on `0.x` until the manifest schema and CLI surface are stable. Do not cut `1.0.0` without an explicit, considered ask.

If the user gives a vague intent ("ship the changes I just made"), look at the diff vs the previous tag (`git log $(git describe --tags --abbrev=0)..HEAD`) and propose a bump with reasoning. Confirm before proceeding.

## Pre-publish checks (locally)

Run these in sequence. Stop on the first failure and report it to the user; do not paper over.

```
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

The `prepublishOnly` script chains these too, but running them now means we fail fast before tagging, instead of failing inside the workflow after the tag is already pushed.

Sanity check the built artifact:

```
node dist/cli.mjs --version
node dist/cli.mjs --help
```

The version printed should still be the *current* version at this point (the bump hasn't happened yet).

## Bump, commit, tag, push

```
pnpm version <patch|minor|major>
```

`pnpm version` bumps `package.json`, commits as `vX.Y.Z`, and creates a matching git tag. No extra `git add` or `git commit` needed.

Push the commit and the tag together:

```
git push --follow-tags
```

This is what fires the release workflow on the tag.

## Watch the workflow

Use the GitHub CLI to surface workflow status to the user:

```
gh run watch --exit-status
```

Or, if a fresh run hasn't appeared yet:

```
gh run list --workflow=release.yml --limit 3
```

If the workflow fails, fetch the logs (`gh run view --log-failed`) and report the failure to the user. Do **not** retag or force-push the existing tag — fix the underlying issue on `main` with a new patch release.

## Verify the publish

Once the workflow succeeds, confirm the new version is live:

```
npm view multree version
```

Should match the just-released `X.Y.Z`. Optionally check provenance:

```
npm view multree --json | jq '.dist.attestations'
```

## Report to the user

End with a short summary: the new version, the workflow run URL, and the npm package URL (`https://www.npmjs.com/package/multree`). Do not narrate the steps you took.

## What this skill does not do

- It does not generate a CHANGELOG — multree doesn't keep one. If you want one later, layer `release-please` on top.
- It does not write release notes. The user can do this on the GitHub Release page if they want; the tag is enough for npm.
- It does not amend, rebase, or force-push. Releases are append-only.
- It does not auto-resolve preconditions. If `main` is dirty or out of date, stop and surface it.
