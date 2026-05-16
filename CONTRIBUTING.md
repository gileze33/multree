# Contributing

Thanks for considering a contribution to `multree`. The bar is low and the workflow is short — open a PR.

## Workflow

1. Fork the repo and create a branch off `main`.
2. Make your change.
3. Add or update tests so the change is covered (see below).
4. Make sure `pnpm typecheck`, `pnpm lint`, and `pnpm test` all pass locally.
5. Open a pull request describing what changed and why.

That's it. No issue required first — feel free to open a PR directly. If you're unsure whether an idea is in scope, open an issue to ask before you build.

## Test coverage

Every behavioural change needs test coverage. The repo has two layers:

- **Unit tests** (`tests/unit/*.test.ts`) — pure modules like env parsing and wiring template substitution. Fast (~0.5s). Prefer these whenever the logic can be exercised without touching the filesystem or spawning a process.
- **Integration tests** (`tests/integration/*.test.ts`) — spawn the real `bin/multree` against sandboxed fixture repos in `tests/fixtures/repos/` via the helpers in `tests/helpers/`. Use these for end-to-end command flows (create, add, remove, rewire, destroy).

If you're adding a new subcommand or changing how an existing one orchestrates hooks/env wiring, you'll usually want an integration test. If you're fixing a parsing or templating bug, a unit test is enough.

Run the suites with:

```bash
pnpm test              # both
pnpm test:unit
pnpm test:integration
```

## Style

- TypeScript, strict mode. No build step — source runs through `tsx`.
- Follow the existing conventions in nearby files for error handling, naming, and module structure (see `CLAUDE.md` for the toolchain rules).
- `pnpm lint` enforces the basics. Run `pnpm lint:fix` to auto-format.
- Don't add comments that describe what the code does. Only add them when the *why* would not be obvious to a future reader.

## License

By contributing, you agree that your contributions will be licensed under the MIT License (see [LICENSE](./LICENSE)).
