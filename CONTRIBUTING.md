# Contributing

Thanks for your interest in Flashbang! This guide covers what you need to know to contribute.

## Quick start

See [DEVELOPMENT.md](DEVELOPMENT.md) for setup instructions and available commands.

## Ways to contribute

- **Bug reports** — Open an issue with steps to reproduce, expected vs actual behavior, and your browser/OS.
- **Feature requests** — Open an issue describing the use case, not just the solution.
- **Bang additions** — Add new bang shortcuts (see below).
- **Code** — Fix bugs, improve performance, or add features.

## Adding bangs

Custom bangs live in [`config/custom.toml`](config/custom.toml). Each entry looks like:

```toml
[bangs.mdn]
name = "MDN Web Docs"
url = "https://developer.mozilla.org/en-US/search?q={}"
domain = "developer.mozilla.org"
```

- The key after `bangs.` is the trigger (e.g. `!mdn`)
- `url` must contain `{}` as the query placeholder
- `domain` is shown in the UI for display

After editing, run `bun run codegen` to regenerate the bang maps.

## Pull requests

- Branch from `master`
- Run `bun test` before submitting
- Use [conventional commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `chore:`
- Keep PRs focused — one concern per PR

## Tests

Tests are co-located with source files as `*.test.ts`. Run them with:

```sh
bun test
```

Add tests for new logic. Look at existing tests for patterns:

- `src/sw/redirect.test.ts` — redirect and routing logic
- `src/suggest.test.ts` — suggestions and cookie parsing

## Code style

Formatting and linting are handled by [Biome](https://biomejs.dev). Run `bun run check` to verify and `bun run fix` to auto-fix.

- Strict TypeScript (`strict: true`)
- ESNext target
- Named exports

## License

Contributions are licensed under [AGPL-3.0](LICENSE), the same license as the project. This is intentional — AGPL ensures that modified versions served over a network remain open source, protecting user privacy.
