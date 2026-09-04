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
  `createAPICallErrorData`, and `SessionAPI` — its
  `SessionAPIOptions.redaction` engine, forwarded at the `dispatch`
  request/response lines, at `logError`, and at the transient-retry
  line's URL) takes the engine and defaults to the base — a forgotten
  parameter degrades to generic-carrier coverage, never to zero
  coverage. `SessionAPI` was seated LATE: unpublished 1.1.0 built its
  `dispatch` log lines with no engine, so an SDK credential key
  (heatzy's `x-gizwits-user-token`) printed in clear from the core
  while the SDK's bound shell masked it — caught by the heatzy
  adoption agent against the packed tarball, pinned since by
  `session-api.test.ts`'s dispatch-log redaction clauses.
- The APICall* shells serialize `url` through `redactUrl`, never
  `redactValue`: the deep walk reads a one-pair query as a single
  `path?key` = value entry whose key names no secret, so an inline
  credential (`?token=…`) passed in clear until the seat fix. Pinned in
  `observability.test.ts`.
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
- `CompositePolicy` stays, and the composition lives HERE now:
  `SessionAPI`'s per-request pipeline composes it, and both SDKs —
  subclasses of `SessionAPI` since their 2026-09-04 adoptions — reach
  it without importing it. (Pre-extraction, melcloud composed with it
  and heatzy hand-nested `run` calls; reconciliation 6 under
  `SessionAPI` below verifies the equivalence byte for byte.)
- `AuthenticationError`'s doc is the protocol-neutral union of the
  twins' (melcloud named the 401 path, heatzy named Gizwits' 400/401);
  which statuses count is `AuthRetryPolicy`'s parameter, not the
  class's business. Its `name` stays typed `string`, not a literal —
  that is what lets `AuthenticationThrottledError` narrow it. The doc
  names that subclass in code font, never `{@link}`: heatzy re-exports
  the class WITHOUT the subclass, so a hard link cannot resolve in its
  `.d.ts` — the code-font name is what lets its shim stay a plain
  re-export.
- `AuthenticationThrottledError` was melcloud-only (heatzy's ledger
  said "No AuthenticationThrottledError"). It came here anyway: the
  session mechanism gates its login backoff on the distinction between
  "password rejected" and "sign-ins refused", so the mechanism could
  not be extracted without it. heatzy simply never
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
machinery that followed, `SessionAPI` below, gates on them — while the
protocol vocabulary (which status means "throttled", which wire field
carries the window) stays in each SDK.

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
machinery, one of the two spelled with `#private` members — and now
carries melcloud's AMENDED 55.0.0 shape (next two paragraphs). Since
2026-09-04 BOTH SDKs subclass it: melcloud's `BaseAPI` and heatzy's
`HeatzyAPI` extend `SessionAPI`, and the machinery below has no other
copy anywhere in the family.

**The mechanism diverged from its source the day it was documented,
which is why the catch-up must precede any adoption.** melcloud shipped
55.0.0 while this section still said "as melcloud-api's `BaseAPI`
(54.0.0)", and what 55.0.0 fixed was a defect the extraction had
carried across: the 54.0.0 `resumeSession` read its verdict off
`isAuthenticated()`, which reported a REFUSED re-sign-in over a live
session as a successful resume — feeding the reactive auth-failure
replay the very credential the server had just refused (on melcloud
Classic, `reauthenticate()` IS `resumeSession`, and it deliberately
does not clear first). The 55.0.0 shape judges by the SIGN-IN
ROUND-TRIP instead: an `#acceptedSignIns` counter bumped the instant
`doAuthenticate` resolves ("nothing below can un-accept it"), compared
across the call by `#reportResumeFailure`. This package carries that
mechanism, the per-dialect MAY on the reactive `clearPersistedSession`
wipe (Classic's measured counter-example: a zone-level `GetSettings`
on a shared building answers `401` while the same context key serves
`/User/ListDevices` — 2026-08-26), and the enforced-sync `@throws` on
`authenticate`. Both halves of the verdict are pinned in
`session-api.test.ts` — "reports a refused re-sign-in as a failed
resume, standing session or not" and "never replays a 401 when the
re-sign-in was refused", mirroring melcloud's kernel clauses — and
mutation-proved: reverting the verdict to `isAuthenticated()` fails
exactly those two. Never restate the verdict as "judge by the
session": that shorthand is HOW the defect happened, and melcloud's
CLAUDE.md now forbids it. The standing rule this episode leaves: an
extraction is not done when it lands — every source release cut after
the move is reconciled HERE before any SDK adopts the core.

**The supersession recurred within 24 hours, which makes that rule
load-bearing, not commemorative.** The day after the 55.0.0 catch-up
landed (#9), melcloud amended its still-unreleased 55.0.0 with three
more session-mechanism fixes (melcloud-api #1759), and SessionAPI
carried all three before any adoption. (1) The `#isCredentialRefused`
record: armed in the resume-failure path by a DEFINITIVE
`AuthenticationError` only — never `AuthenticationThrottledError`,
whose lockout says nothing about the pair, and never a transport blip
— lifted by the next accepted sign-in, and consulted by the sync-cycle
epilogue through `isSessionServable()` (`isAuthenticated() &&
!refused`), so a server-side password change surfaces
`onAuthenticationLost` once per episode while the stale session
deliberately stays stored. `isSessionServable()` is the record's ONE
protected read — promoted from `#private` when melcloud's adoption
showed `ensureAuthenticated` (a melcloud-only surface this package
does not carry) must judge the RECORDED verdict on every rung, and
without a seam it had mirrored the record in ~60 local lines that
could diverge from the core's in extreme races. The record's writes
stay this class's alone (`#isCredentialRefused` remains private), and
the read's contract — true over a live unrefused session, false once
refused, true again after the next accepted sign-in — is pinned in
`session-api.test.ts` ("the protected servability read"). (2) `RegistrySyncError`
(`src/errors/registry-sync.ts`, extending `APIError`, exported through
both barrels): `authenticate()` wraps whatever `enforceRegistrySync()`
propagates, the sync's own failure preserved as `cause`; a refused
credential is NEVER wrapped — it stays `AuthenticationError`. (3) The
`resumeSession` single-flight: the `#resumePromise` memo with the
`#resumeAcceptedBefore` counter snapshot, so N concurrent lifecycle
callers share ONE `doAuthenticate` and a caller joining after the
accepted verdict answers without awaiting the enforced sync still
running behind it (the one real caller in that window is the reactive
auth-failure path that sync itself triggered — do not "simplify" that
branch into an await). All three are pinned in `session-api.test.ts`
(the arm/clear/consult triangle with the throttle and transport
exclusions, the wrap-with-cause + never-wraps-refusal pair, N
concurrent resumes → one `doAuthenticate`) and mutation-proved:
eleven mutations, each killed by its named clause. Twice in 24 hours
is a pattern, not an accident — reconcile every melcloud release here
BEFORE any SDK adopts the core.

**The seam is thirteen members, verified against BOTH SDKs before the
move, and BOTH SDKs implement it through `extends SessionAPI` since
their 2026-09-04 adoptions**: twelve abstract hooks —
`clearPersistedSession`,
`clearRegistry`, `doAuthenticate`, `enforceRegistrySync`,
`getAuthHeaders`, `hasPersistedSession`, `isAuthenticated` (the one
PUBLIC abstract), `needsSessionRefresh`, `performSessionRefresh`,
`reauthenticate`, `reuseSucceeded`, `syncRegistry` — plus the virtual
`logError` (melcloud Home overrides it to keep its `/context` 404 out of
the call log). melcloud declared all thirteen already, so its adoption
was a re-point. heatzy's pre-adoption shape was LOOSER than this section
claimed until 2026-08-30, and the difference is the part of the move
worth recording — measured against heatzy-api 15.0.0, the last release
before its adoption, whose `HeatzyAPI` extended nothing and carried no
`override` at all. Of the twelve abstract hooks,
SEVEN were `#private` methods (`clearPersistedSession`, `clearRegistry`,
`doAuthenticate`, `getAuthHeaders`, `needsSessionRefresh`,
`performSessionRefresh`, `reauthenticate`), ONE was a public method
(`isAuthenticated` — public there as it is here), and FOUR had no
method of their own at all: they were inline expressions inside two
OTHER methods. `enforceRegistrySync` was the bare `await
this.#syncCycle()` that closed `#finishLogin`, while
`hasPersistedSession`, `syncRegistry` and `reuseSucceeded` were the
three
successive statements of `#tryReuseSession` (`if (this.token === '')`,
`await this.fetch()`, `return this.isAuthenticated()`). The virtual
thirteenth, `logError`, WAS a private method there. So nothing was
invented for the move — every hook had a body — but four of them had to
be NAMED, and naming them is what heatzy's adoption did: a reader
comparing its pre-adoption code against the seam finds four of the
twelve by reading two methods, not
by grepping for their names. Everything that differed only by DATA
became a constructor
option: `SessionAPIOptions` is `{ defaultSyncIntervalMinutes,
syncCallback, transport, authFailureStatuses?, logLabel?,
rateLimitHours?, redaction? }`, beside the user-facing `SessionAPIConfig`
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
devices". Both halves are pinned as clauses of their own.

melcloud's contract kernel NOW catches a swap in both directions, which
it did not when the paragraph above was first written: its
kernel-hardening pass (melcloud-api #1752) added the clauses that hold
it. Re-run of the same mutation on 2026-08-30, against melcloud-api at
54.1.0 — pointing `tryReuseSession` at the propagating hook fails
"keeps the boot-time probe non-destructive when the wire is
unavailable" on BOTH dialect legs; pointing the post-auth epilogue at
the best-effort one fails "runs the enforced registry cycle on an
accepted sign-in and rejects when it fails" and "never arms the login
backoff when only the registry cycle failed", again on both. Keep this
suite's clauses anyway: they witness a different thing. The kernel pins
the split as the two SDKs WIRE it, through their own subclasses; these
clauses pin it as the mechanism OFFERS it, which is what a third
consumer would inherit.

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
2. **Logger labelling → symmetric since 2026-09-05; the move carried
   melcloud's asymmetry byte for byte until its deferral expired.**
   `logLabel` is OPTIONAL: absent, the raw logger is used unwrapped
   (heatzy's shape — a no-label host's output stays byte-identical);
   present, EVERY seat receives the labelled wrapper, the `SyncManager`
   included. The manager originally kept the RAW logger because that is
   what melcloud passed at extraction time: the asymmetry was a latent
   bug — `Auto-sync failed:` reached a host running both dialects with
   no `[Classic]`/`[Home]` prefix — but those strings land verbatim in
   user diagnostic reports, and an incidental cleanup inside a
   neutrality-critical move would have made the before/after proof
   false, so the fix was recorded for its own PR "after both adoptions
   land". Both landed 2026-09-04; the deferral expired and the fix
   followed in 1.2.0. Consumer effect, for the release notes:
   melcloud's SyncManager lines gain their label prefix on its next
   adoption; heatzy passes no label, so its output does not change.
   Both halves are pinned in `session-api.test.ts` — the labelled-seat
   clause and the no-label byte-identity clause.
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

### Exports with no external consumer — verdict, 2026-09-05

Audited after both 2026-09-04 adoptions: the policy toolkit
(`AuthRetryPolicy`, `CompositePolicy`, `RateLimitPolicy`,
`TransientRetryPolicy`, the retry-backoff surface — `withRetryBackoff`,
`DEFAULT_TRANSIENT_RETRY_OPTIONS`, `RetryBackoffOptions` —
and `DisposableTimeout`) and the base redaction pair
(`BASE_SENSITIVE_KEYS`, `baseRedaction`) currently have NO external
consumer — `SessionAPI` constructs every one of them internally, and
both SDKs reach them only through it. They STAY exported: an
unconstructed export costs a consumer nothing, a host composing its own
client outside `SessionAPI` may want exactly these pieces, and trimming
them would be a major for nothing. `api-surface.test.ts` pins the set;
this verdict exists so a future audit reads a decision here instead of
re-deriving one.

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

## Bootstrap order — the fault this repo's own history records

**1.0.0 shipped from a commit no gate ever judged.** Measured from this
repo's history (2026-08-27, all times UTC): the seed commit `702f5e0`
was pushed STRAIGHT TO `main` at 17:58:09, the `Protect main` ruleset
was created at 17:58:13 — four seconds later — and `v1.0.0` was tagged
on that same seed commit at 18:53 and adopted by both SDKs by 19:14.
The repo's first CI run on `main` is dated 2026-08-28, a day AFTER the
release. Publishing never needed the missing secrets (`publish.yml`
wants the `npm` environment and the job `GITHUB_TOKEN`; `SONAR_TOKEN`
gates nothing there), so nothing stopped a release whose code had
passed no gate of its own.

What did cover it, for the record: the full local suite, PR #1's CI
legs running the same tree green at 18:11 (only `ci / Sonar` red, for
want of a project), and both consumers' adoption suites. That is
evidence, not a gate — and the difference is the point.

**The order for the next repo**: create the repo, the ruleset, the
environments, the SonarCloud project and its token FIRST; land the
code through a PR that goes green; release only then. A first release
must never precede a first gated merge — the one commit that most
needs review is the one that defines the package.
