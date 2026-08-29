# CLAUDE.md

Shared API-client core for the OlivierZal SDKs (`melcloud-api`,
`heatzy-api`), published to GitHub Packages and pinned EXACTLY by every
consumer — adoption is a reviewed PR per release, never a range. ESM
only, Node >= 22.20.

The README speaks to the package's CONSUMER (install, subpaths, the
vocabulary and session seams); this file speaks to its MAINTAINER. Doctrine evolves
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
- `AuthenticationError`'s doc is the protocol-neutral union of the
  twins' (melcloud named the 401 path, heatzy named Gizwits' 400/401);
  which statuses count is `AuthRetryPolicy`'s parameter, not the
  class's business. Its `name` stays typed `string`, not a literal —
  that is what lets `AuthenticationThrottledError` narrow it.
- `AuthenticationThrottledError` was melcloud-only (heatzy's ledger
  said "No AuthenticationThrottledError"). It comes here anyway: the
  session mechanism that follows gates its login backoff on the
  distinction between "password rejected" and "sign-ins refused", so
  the mechanism cannot be extracted without it. heatzy simply never
  constructs it — an unconstructed export costs a consumer nothing.
- The session mechanism's own six reconciliations are listed with it,
  under `SessionAPI` below — they belong to that move, not to this
  list.

## The session prerequisites — why these four, and the probe

`AuthenticationError`, `AuthenticationThrottledError`,
`LoginCredentials` and the `setting` decorator landed together, ahead
of the session-lifecycle mechanism itself, because that mechanism gates
on all four: it backs off on the throttled error, signs in with the
credentials pair, and persists `expiry` / `loginBackoffUntil` /
`password` / `username` through the decorator. They are
mechanism-adjacent by the same logic that moved `HttpError` — the
machinery that will follow gates on them — while the protocol
vocabulary (which status means "throttled", which wire field carries
the window) stays in each SDK.

**The storage key is the accessor name, and that is a data contract.**
`setting` resolves its key as `String(context.name)`, once at
decoration time. Hosts already hold values under `expiry`,
`loginBackoffUntil`, `password` and `username`; renaming a decorated
accessor renames its key and strands the stored value. Nothing may
change how the key is derived —
`tests/unit/setting-decorator.test.ts` pins the four literals against
the keys a mock `SettingManager` actually observes, and derives the key
by hand from a fabricated context so the rule is asserted as an input,
not inferred from class syntax.

**The decorator needed a probe because nothing here had proven it.**
This package had no decorator and no decorator overlay in its ESLint
config, and no one had shown that a TC39 accessor decorator survives a
PACKAGE BOUNDARY under `isolatedDeclarations` and the native
TypeScript 7 compiler — the emit lives in the CONSUMER, so a working
build here would have proved nothing. Probed before any of the rest was
written, with a throwaway consumer package that resolved
`@olivierzal/api-core` to this repo and applied the BUILT decorator to
its own accessors: the native compiler typechecked and emitted it
(exit 0 both times), the emitted `__esDecorate` ran, and the four keys
came back exactly. Two facts the probe settled and the code now
depends on:

- The `HasSettingManager` host contract stays UNEXPORTED.
  `isolatedDeclarations` is satisfied by a file-local interface —
  declaration emit inlines it — so the public surface gains one name
  (`setting`), not two. It costs a typedoc
  `intentionallyNotExported` entry, exactly as heatzy-api's copy did.
- No ESLint overlay was needed. The `library` preset already admits
  standard decorators, and the tsconfig base's `erasableSyntaxOnly`
  does not reject them; the vitest `swcPlugin` (already adopted here
  before there was anything to transform) runs the 2022-03 protocol in
  the suites.

## The session mechanism — `SessionAPI`

`SessionAPI` is the session lifecycle and the request pipeline both
SDKs carried: the persisted credentials and the login-backoff gate, the
logOut-epoch protocol, the auth-lost / auth-restored episode tracking,
single-flight `ensureSession`, `request` / `dispatch` and the policy
composition around them, the sync-cycle trio (strict `runSyncCycle`,
best-effort `runBestEffortSyncCycle`, and the epilogue that reschedules,
re-applies a raced sign-out, or surfaces a loss), and the public
lifecycle `authenticate` / `resumeSession` / `initialize` / `logOut` /
`start` / `notifySync` / `clearSync` / `setSyncInterval` /
`[Symbol.dispose]`. It arrived as melcloud-api's `BaseAPI` (54.0.0) and
heatzy-api's inline copy inside `HeatzyAPI` (14.1.x) — the same
machinery, one of the two spelled with `#private` members.

**The seam is thirteen members, verified against BOTH SDKs before the
move**: twelve abstract hooks — `clearPersistedSession`,
`clearRegistry`, `doAuthenticate`, `enforceRegistrySync`,
`getAuthHeaders`, `hasPersistedSession`, `isAuthenticated` (the one
PUBLIC abstract), `needsSessionRefresh`, `performSessionRefresh`,
`reauthenticate`, `reuseSucceeded`, `syncRegistry` — plus the virtual
`logError` (melcloud Home overrides it to keep its `/context` 404 out of
the call log). melcloud declared all thirteen already; heatzy carried
each as a private method with the same body, so nothing was invented for
the move. Everything that differed only by DATA became a constructor
option: `SessionAPIOptions` is `{ defaultSyncIntervalMinutes,
syncCallback, transport, authFailureStatuses?, logLabel?,
rateLimitHours? }`, beside the user-facing `SessionAPIConfig`
(`abortSignal`, `events`, `logger`, `settingManager`,
`syncIntervalMinutes`), generic in the consumer's sync-params shape.

**The replicated `unicorn/prefer-await` disable did not cross.** Both
twins guard `ensureSession`'s single-flight memoization with an inline
disable, because `.finally()` on the hook's promise is what the rule
refuses. The core expresses the same semantics as a private `#refresh`
whose `try`/`finally` releases the handle — identical single-flight
behaviour, one fewer suppression. Existing disables are debt: removed
when the code they guard is touched, never replicated.

**The four persisted keys are written from HERE now.** `expiry` is
`protected` (subclasses read and write it), `loginBackoffUntil`,
`password` and `username` are private to the mechanism — all four
declared as TS-`private`/`protected` `accessor`s, never `#private`
ones, because `setting` resolves the key as `String(context.name)` and
a `#` name would persist under `#loginBackoffUntil`.
`tests/unit/session-api.test.ts` pins the literal strings a mock
`SettingManager` observes on all three routes — the `set` keys, the
`get` keys, and the `unset` deletions a sign-out issues — on top of
`setting-decorator.test.ts`'s derivation rule.

**`#armLoginBackoff` gates on `error instanceof AuthenticationError`,
and the gate guards the LOGIN only.** Three clauses hold it: a rejected
sign-in ARMS it (900 000 ms, or the throttle branch), a transport
failure does NOT (the normal retry paths own those, and pausing
sign-ins would mask a blip), and a failing post-auth registry sync does
NOT either — the server already accepted the credentials, so locking
the user out over a registry problem would be wrong. Only the `catch`
around `doAuthenticate` can arm it.

**`syncRegistry` and `enforceRegistrySync` are not interchangeable, and
the split is load-bearing in BOTH directions.** `tryReuseSession` calls
the BEST-EFFORT `syncRegistry`: `initialize()` has no try/catch and
every SDK's `create()` awaits it, so a propagating probe would turn a
boot-time network blip into an app that refuses to start instead of one
that degrades to "not authenticated yet". The enforced post-auth sync is
the mirror image — it must propagate, or `authenticate()` resolves over
an empty registry, which consumers read as "this account has no
devices". Both halves are pinned as clauses of their own; melcloud's
contract kernel did NOT catch a swap of the two hooks
(mutation-proven), so this suite is where it is held.

### What stayed out, and why

- **`requestData`, `safeRequest`, `classifyError`,
  `normalizeUnauthorized`, the `Result` type.** They sit on the
  zod/Result boundary and would drag zod's type surface into this
  package's `.d.ts`; the standing verdict above refuses a zod entry.
- **The transport RESOLUTION (`instanceof HttpClient` +
  `DEFAULT_TIMEOUT_MS`) — SECURITY-LOAD-BEARING.** Each SDK decides
  whether a host-supplied `transport` is a usable client or a bag of
  build options, and its check reads `instanceof <its own>
HttpClient` — the thin subclass that seats the SDK's redaction
  vocabulary. Moved here, that same check would read `instanceof
HttpClient` against the CORE class, and so ACCEPT a host-prebuilt
  bare core client carrying only `BASE_SENSITIVE_KEYS` where today the
  SDK discards it and builds its own. That is exactly the failure class
  of the 2026-08-21 credential leak: a transport whose thrown snapshots
  miss the protocol's credential keys. `SessionAPI` therefore takes an
  ALREADY-BUILT `HttpClient`, and each SDK keeps its resolver.
- **`ensureAuthenticated` and `isRateLimited`.** melcloud-only
  surfaces; moving them would widen heatzy's published class with
  members it never asked for. `isRateLimited` needs the gate, so
  `rateLimitGate` is `protected` here — and `undefined` when no rung
  was built.
- **The protected `syncManager` getter.** melcloud declared it; no
  subclass in either SDK ever read it. The manager stays private.

### The six reconciliations

1. **`#runWithEvents` duration clock → `performance.now()`** (melcloud
   used `Date.now()`, heatzy `Temporal.Now`). Same verdict, same reason
   as `RetryGuard`'s window: a system-clock adjustment mid-request
   would otherwise hand every observer a negative or wildly inflated
   `durationMs`. The test seam differs from a wall-clock one ON
   PURPOSE — `vi.setSystemTime()` moves `Date.now()` and leaves
   `performance.now()` alone, which is what the clause asserts (a
   year-long backwards jump mid-request still reports
   `durationMs: 0`); only `vi.advanceTimersByTime` moves it.
2. **Logger labelling → melcloud's asymmetry, byte for byte.**
   `logLabel` is OPTIONAL: absent, the raw logger is used unwrapped
   (heatzy's shape); present, every seat receives the labelled wrapper
   — EXCEPT the `SyncManager`, which keeps the RAW logger because that
   is what melcloud passes today. **Follow-up, deliberately not fixed
   here:** that asymmetry is a latent bug — `Auto-sync failed:` reaches
   a host running both dialects with no `[Classic]`/`[Home]` prefix. It
   stays as-is because those strings land verbatim in user diagnostic
   reports, and an incidental cleanup inside a neutrality-critical move
   would make the before/after proof false. Fix it in its own PR, after
   both adoptions land.
3. **Throttle branch → melcloud's superset.**
   `AuthenticationThrottledError` plus the announced-window resolver
   (the server's own countdown wins, floored by nothing and capped by
   the 2-hour ceiling, which is also the fallback when it announced
   none) come here; heatzy inherits a branch it never constructs, which
   costs it nothing.
4. **`dispatch` per-call header merge → melcloud's general form.**
   heatzy wrote the auth headers alone, calling the merge a dead branch
   on its wire; the core carries the general form and this suite covers
   it — including the clause that the auth headers WIN over a colliding
   per-call header.
5. **`[Symbol.dispose]` → melcloud's superset**: the sync manager AND
   the retry guard.
6. **The rate-limit rung is OPTIONAL**, built only when the subclass
   passes `rateLimitHours` (heatzy's ledger refuses the gate outright:
   the Gizwits wire has never surfaced a 429). Verified in
   `src/resilience/policy.ts` before relying on it — `CompositePolicy`
   reverses the array once and wraps innermost-first, so `[authRetry]`
   runs exactly `authRetry.run(attempt)` and `[authRetry, transient]`
   runs exactly `authRetry.run(() => transient.run(attempt))`:
   byte-for-byte heatzy's hand-nesting.

The class name is `SessionAPI`, settled: it names the MECHANISM rather
than a position in either SDK's hierarchy, and leaves melcloud's
`BaseAPI` free to stay `BaseAPI` on top of it.

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

## First-run ledger — measured 2026-08-27, closed 2026-08-29

Facts observed on the scaffold's first CI run, kept here so nobody
re-derives them. The console wiring the first run waited on is DONE:
`SONAR_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN` and the Dependabot
`MY_GITHUB_PERSONAL_TOKEN` were set on 2026-08-28, the `npm` and
`github-pages` environments exist (1.0.0 published to GitHub Packages,
proven by `npm view`; the Pages policy admits `v*` tags, so a docs
re-dispatch targets the tag ref, not `main`).

- **The configs install needs no repo secret in CI.** Every
  reusable-ci leg installed `@olivierzal/configs` with the job-scoped
  `GITHUB_TOKEN` (`packages: read`) — same as the siblings; no
  `npm-token`-style secret exists to set.
- **SonarCloud surfaces security hotspots as ISSUES here.** The
  organization's mode converts `former-hotspot` rules (S2245) into
  `VULNERABILITY` issues: `/hotspots/search` answers zero while the
  quality gate still fails on the open issue — query `/issues/search`
  with the rule key before concluding there is nothing to adjudicate.
  The verdict lives ON the issue (Accepted + rationale), mirrored by
  the comment at the flagged line; heatzy's twin S2245 was only ever
  auto-resolved by code removal, so this is the family's precedent.
