# CLAUDE.md

Shared API-client core for the OlivierZal SDKs (`melcloud-api`,
`heatzy-api`), published to GitHub Packages and pinned EXACTLY by every
consumer — adoption is a reviewed PR per release, never a range. ESM
only, Node >= 22.20.

The README speaks to the package's CONSUMER (install, subpaths, the
vocabulary seam); this file speaks to its MAINTAINER. Doctrine evolves
HERE first — a rule stated in both files must say the same thing, and
the README carries at most a one-line pointer at it.

## Why this package exists — the expired deferral

The two API SDKs carried these mechanisms as byte-identical twins,
marked in-source ("Byte-identical twin … the two repos have no
dependency, so edit both or neither") because the `api-core` extraction
had been weighed and DEFERRED. The deferral's reason expired on
2026-08-21: a security fix — whole-snapshot credential redaction seated
in the `HttpError` constructor — landed in one repo and took FOUR DAYS
to reach its twin, and during that window the un-fixed twin shipped a
release that leaked credentials into thrown-error snapshots. A
discipline that survives only while every edit is mirrored by hand is
not a discipline; the twins now live here, and a consumer that wants
the fixed mechanism gets it by bumping ONE pin. That incident is the
bar for this package: the redaction engine is a SECURITY mechanism
first, an observability nicety second.

## Commands

Run the FULL suite before any push; check real exit codes:

- `npm run build` — purges `dist` before emitting (`tsc` overwrites but
  never deletes; `files` ships that directory).
- `npm run format` / `npm run format:fix` — prettier (preset from
  `@olivierzal/configs/prettier`).
- `npm run lint` / `npm run lint:fix` — ESLint over the
  `@olivierzal/configs` library preset plus this repo's overlay: the
  HTTP reason-phrase naming exemption scoped to `src/http/status.ts`,
  the webview floor on the consumer-bundleable leaves, and the `u`-flag
  regex pin over all of `src` (see Runtime floors).
- `npm run typecheck` — the native TypeScript 7 compiler, reached by its
  explicit path (`node ./node_modules/@typescript/native/bin/tsc`). A
  bare `tsc` silently typechecks with TypeScript 6 — only the explicit
  path holds.
- `npm test` / `npm run test:coverage` — vitest; thresholds are 100 %
  on all four axes, over the whole of `src/` with no exception.
- `npm run docs` — typedoc; the Pages site deploys on release.
- `npm run lint:package` — build + `publint --strict`.

## What enters this package — the mechanism bar

A module enters when it is a MECHANISM both SDKs need: transport,
redaction, retry, scheduling, logging shells. It stays out when it is a
protocol VOCABULARY: sensitive-key sets, wire types, zod schemas,
status-code semantics, endpoint knowledge. The test is parameterizability:
if the two consumers' copies differed only by data (keys, statuses,
zones), the mechanism comes here and the data becomes a constructor or
config parameter; if they differed structurally for protocol reasons,
the module stays in its SDK. `parseOrThrow`/`ValidationError` stayed
out on a second bar — they would couple this package's release cadence
to zod's for a 14-line win.

## The redaction seat — non-negotiables

- The vocabulary is INJECTED, never owned: `createRedaction(extraKeys)`
  unions the consumer's keys with `BASE_SENSITIVE_KEYS`. The base is
  the INTERSECTION of the consumers' historical sets (`authorization`,
  `cookie`, `set-cookie`, `password`, `username`, `email`, `token`), so
  adopting the core can only ever redact MORE, never less.
- Redaction happens at CONSTRUCTION — `HttpError` sanitizes its whole
  snapshot (request headers/body/params/url-query, response
  headers/body) in its constructor, so no call site can retain a
  credential by forgetting to sanitize. Never move it to log time.
- Every seat (HttpClient, HttpError, the APICall* shells,
  `createAPICallErrorData`) takes the engine and defaults to the base —
  a forgotten parameter degrades to generic-carrier coverage, never to
  zero coverage.
- The extracted behavior is the UNION of what the twins did when they
  diverged: response BODY and URL-query redaction (melcloud 52.0.x) AND
  header/body/params redaction (heatzy 14.0.0), plus the JSON-text
  branch in `redactValue` (melcloud 52.0.1).

## Reconciliations — settled, not silent

Where the twins had drifted, this package settles the difference once:

- `AuthRetryPolicy` takes the auth-failure statuses as a parameter
  (default `[401]`; heatzy passes `[401, 400]` for Gizwits).
- `RetryGuard` keeps heatzy's monotonic `performance.now()` deadline
  (immune to clock jumps, no timer to leak) AND melcloud's
  `Disposable` surface — dispose resets the window.
- `isSessionExpired` keeps melcloud's optional IANA `zone` parameter
  for offset-less inputs; zone-less callers are unaffected.
- `createAPICallErrorData` accepts any `Error` (melcloud's shape) —
  heatzy's `HttpError`-only narrowing widens compatibly.
- `HttpStatus` is the union table (400/401/404/429/502/503/504) with
  protocol-neutral docs.
- `parseBody` uses heatzy's single emptiness check (a 204 and a
  `content-length: 0` body both read back as empty text).
- `CompositePolicy` stays (melcloud composes with it; heatzy nests
  `run` calls directly and simply doesn't import it).

## Runtime floors

- **Engines: `>=22.20.0`, derived, not copied.** The floor is the
  highest of: what the code needs (iterator helpers in the redaction
  engine — Node 22), what the dependency tree demands
  (`temporal-polyfill` declares no floor), and where the code RUNS —
  this package ships inside the SDKs, which install as production
  dependencies of the Homey apps, whose measured device floor is Node
  22.20. Re-derive on change; never copy a sibling's number blindly.
- **`u`-flag regexes over all of `src`** — the consuming SDKs are
  bundled INTO their apps' phone webviews (melcloud-api's `/constants`
  values are inlined into shipped widget bundles), and the worst engine
  the Homey app admits, iOS 16.4's WebKit, predates the `v` flag. Same
  pin, same trigger as melcloud-api: the App Store minimum reaching
  17.4 re-opens es2024 (the family's `ios-floor-watch` guards it).
- **Webview es2023 floor on the consumer-bundleable leaves only**
  (`fire-and-forget.ts`, `temporal.ts`, `time-units.ts` — the flat
  modules a consumer's webview-reachable closure can re-export;
  melcloud-api's `/temporal` does). The deep mechanism layers (http,
  observability, resilience, api, errors) are node-only in every
  consumer and keep the modern-API freedom — the redaction engine's
  iterator helpers depend on it. Composed from the configs preset's
  `webviewFloorBlock`; never re-derive it by hand.

## Consumers re-export, surfaces stay theirs

Each SDK keeps its public names (`HttpClient`, `HttpError`,
`APIError`, the lifecycle types) and re-points them here. Their
`HttpClient` is a thin subclass seating the SDK's redaction engine, so
a host-prebuilt transport carries the vocabulary automatically; their
`LifecycleEvents`/`SyncCallback` instantiate the generic with their
sync-params shape. A change to any public shape here is versioned by
the CONTRACT: a signature change is a major even when both known
consumers already comply.

## Governance files

`SECURITY.md` and `CONTRIBUTING.md` exist because this package is a
public npm artifact whose code runs on end-user hardware inside the
consuming SDKs. There is deliberately **no `CHANGELOG.md`**: the
changelog channel is the GitHub release notes, written around what a
consuming SDK must do to adopt the release.

`.github/dependabot.yml` carries `cooldown: default-days: 7` on both
update entries, as the family repos do.

## Process

Family process applies: Conventional Commits PR titles (squash, the
title IS the commit), CI green + Copilot threads resolved before merge,
Sonar zero on BOTH windows verified BEFORE merge, publish via GitHub
Release → `publish.yml` (GitHub Packages, provenance-attested),
registry proven by `npm view` before any "published" claim. Version by
the CONTRACT, not by observed consumers.
