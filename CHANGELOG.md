# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [v0.2.0](https://github.com/gileze33/multree/compare/v0.1.1...v0.2.0)

### Merged

- Add profile system: ~/.multree/&lt;profile&gt;.yaml with aliases [`#33`](https://github.com/gileze33/multree/pull/33)
- Reject "." and ".." as group names to prevent path traversal [`#32`](https://github.com/gileze33/multree/pull/32)
- Dedup and simplify cross-file helpers [`#31`](https://github.com/gileze33/multree/pull/31)
- Cover gaps in integration test coverage [`#30`](https://github.com/gileze33/multree/pull/30)
- Extract runMemberHook helper, add list/prime/failure-output coverage [`#29`](https://github.com/gileze33/multree/pull/29)
- Fix correctness issues: argv-form exec, atomic state writes, awaited teardown [`#28`](https://github.com/gileze33/multree/pull/28)
- Add parallel hook orchestration with depends_on, timeouts, --plan, --resume, --verbose (#2) [`#27`](https://github.com/gileze33/multree/pull/27)
- Add notify-only update check against the npm registry [`#26`](https://github.com/gileze33/multree/pull/26)
- Add status, update, and push commands for group management [`#25`](https://github.com/gileze33/multree/pull/25)
- chore(deps): bundle dependabot updates [`#23`](https://github.com/gileze33/multree/pull/23)
- Generate CHANGELOG.md via auto-changelog on pnpm version [`#21`](https://github.com/gileze33/multree/pull/21)
- Bump actions/checkout from 4 to 6 [`#14`](https://github.com/gileze33/multree/pull/14)
- Bump github/codeql-action from 3 to 4 [`#15`](https://github.com/gileze33/multree/pull/15)
- Bump eslint from 9.39.4 to 10.4.0 [`#19`](https://github.com/gileze33/multree/pull/19)

### Fixed

- Add status, update, and push commands for group management (#25) [`#1`](https://github.com/gileze33/multree/issues/1)

### Commits

- chore: less dependabot non security [`aac3a90`](https://github.com/gileze33/multree/commit/aac3a901c788593f025bfa5adadec5119b4d1ed6)

## v0.1.1 - 2026-05-16

### Merged

- Set up npm publish via tsdown + OIDC release workflow [`#20`](https://github.com/gileze33/multree/pull/20)
- Add CodeQL, dependency-review, and Dependabot config [`#10`](https://github.com/gileze33/multree/pull/10)
- Expand test coverage and document repo-agnostic convention [`#9`](https://github.com/gileze33/multree/pull/9)

### Commits

- Initial commit: multree multi-repo worktree orchestrator [`60ca899`](https://github.com/gileze33/multree/commit/60ca8996b5ecabda636c999692aa19e89f233829)
- Prepare repo for public release on github.com/gileze33/multree [`8475b99`](https://github.com/gileze33/multree/commit/8475b99d22e6ce2012a683c97e3c7161dd3a3390)
- Pin pnpm@11 in CI via packageManager field [`d45c256`](https://github.com/gileze33/multree/commit/d45c256e06496a6c8d881f642de86e23cfeab0c2)
- Drop Node 20 from CI matrix [`92f7b1d`](https://github.com/gileze33/multree/commit/92f7b1db902997a078595b384fa4958ecde53c87)
- Approve esbuild build scripts in pnpm workspace [`35af17c`](https://github.com/gileze33/multree/commit/35af17cccf7b6b5c1670470810c8e4537936578d)
