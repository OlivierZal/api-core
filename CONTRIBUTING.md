# Contributing

Thanks for considering a contribution. This document describes the local
workflow expected before opening a pull request.

## Prerequisites

- Node.js matching `engines.node` in [`package.json`](package.json) —
  currently `>=22.20.0`, derived from where this code runs (see
  `CLAUDE.md` → Runtime floors)
- npm 10+
- A GitHub personal access token with the `read:packages` scope, exported
  as `NODE_AUTH_TOKEN` — [`.npmrc`](.npmrc) reads that variable to fetch
  the `@olivierzal/configs` development dependency

## Setup

```sh title="setup"
git clone https://github.com/OlivierZal/api-core.git
cd api-core
npm ci
```

## Local checks

Run the same suite CI runs on every pull request:

```sh title="checks"
npm run typecheck       # native tsc --noEmit
npm run lint            # ESLint with the shared library preset
npm run format          # prettier --check (npm run format:fix to write)
npm test                # vitest run
npm run test:coverage   # vitest run --coverage (must remain at 100%)
npm run docs            # typedoc
npm run lint:package    # build + publint --strict
```

`prepublishOnly` chains tests, typecheck, lint, format and docs, so
publishing without them passing is impossible.

## Coverage

Branches, functions, lines and statements are all enforced at **100%** in
[`vitest.config.ts`](vitest.config.ts). New code must arrive with the
tests that keep those thresholds green.

## Mechanism only — vocabularies stay out

This package owns the MECHANISMS the `@olivierzal` API SDKs share;
protocol vocabularies (sensitive-key sets, wire types, schemas) live in
the consuming SDKs and arrive here through parameters. Before adding a
module or a key, read `CLAUDE.md` → "What enters this package". A
change to the redaction engine is a security change — treat it with
the care `SECURITY.md` describes.

## Pull requests

- Conventional Commits PR title (it becomes the squashed commit).
- CI must be green; Copilot review threads resolved.
- A behavioral change lands in the consumers only through a release
  plus a pin-bump PR in each SDK — say so in the PR description when
  your change expects an adoption train.
