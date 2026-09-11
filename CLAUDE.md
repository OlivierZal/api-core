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
- `npm run docs` — typedoc; the Pages site deploys on release. typedoc
  and the two plugins the configs preset names
  (`typedoc-plugin-coverage`, `typedoc-plugin-mdn-links`) are THIS
  repo's devDependencies, on purpose: typedoc loads the plugins by name
  from the consumer's tree, and configs 5.0.0 declares none of the
  three in any field the installer reads — GitHub Packages strips
  `peerDependenciesMeta` from the packument, so an optional peer there
  would reach every consumer, the apps included, as a mandatory one
  (measured in configs, 2026-09-07). Dependabot moves the three pins
  here; the majors configs proves the preset against are its README's
  (typedoc 0.28, coverage 4, mdn-links 5).
- `npm run lint:package` — build + `publint --strict`.

## What enters this package — the mechanism bar

A module enters when it is a MECHANISM both SDKs need: transport,
redaction, retry, scheduling, logging shells. It stays out when it is a
protocol VOCABULARY: sensitive-key sets, wire types, zod schemas,
status-code semantics, endpoint knowledge. The test is parameterizability:
if the two consumers' copies differed only by data (keys, statuses,
zones), the mechanism comes here and the data becomes a constructor or
config parameter; if they differed structurally for protocol reasons,
the module stays in its SDK. `parseOrThrow` stayed out on a second bar —
its signature is `z.ZodType<T>`, so it would couple this package's
release cadence to zod's for a 14-line win. `ValidationError` was
refused with it until 1.3.0 on a reason that never applied to the
class: it imports nothing from zod (the validator's error rides `cause`
as `unknown`), and the two SDKs carried it as a byte-identical twin. It
lives here now, `src/errors/validation.ts` through both barrels, and the
SDKs re-export it exactly like `RegistrySyncError`.

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

**Since 1.3.0 the seam also offers one protected TEMPLATE helper,
`toAuthFailure(error, message)`.** Both SDKs carried the sign-in
normalization as module-level twins differing only by data —
melcloud's `normalizeUnauthorized` (401, "MELCloud rejected the
credentials") and heatzy's `toAuthFailure` (400 or 401, "Heatzy
rejected the credentials") — and the status set was ALREADY a
`SessionAPIOptions.authFailureStatuses` parameter, so heatzy spelled it
twice. The helper narrows an `HttpError` whose status is in that
vocabulary into `AuthenticationError` with the original as `cause` and
answers `null` otherwise. **A subclass's `doAuthenticate` spells the
`null` branch as a BARE rethrow, in two statements** — `const authError
= this.toAuthFailure(error, '<Vendor> rejected the credentials')`, `if
(authError !== null) throw authError`, then `throw error` — never as
the one-liner `throw this.toAuthFailure(…) ?? error`. The one-liner
was this paragraph's first prescription, and it does not lint in a
consumer: under the family `library` preset,
`@typescript-eslint/only-throw-error` (unknown disallowed) admits a
catch-clause variable thrown bare as a rethrow, but the `??` expression
whose right operand is that variable is typed `unknown` and refused
("Expected an error object to be thrown") — reported by melcloud-api's
dry adoption at its `src/api/home.ts:592` on 2026-09-07 and reproduced
here the same day with a probe under this repo's own overlay (the
one-liner: one error; the two-statement form: clean). No disable
answers it — the family forbids new ones — and no helper shape does
either: a `never`-returning throwing variant would have to throw its
`unknown` parameter inside this package, which the same rule refuses
here. The README's session snippet and `session-api.test.ts`'s fixture
spell the two-statement form, so the pinned clauses exercise the shape
both SDKs carry. The vocabulary stays spelled once: `AuthRetryPolicy`
owns it and answers `isAuthFailure(error)` publicly, and the helper
consults the policy rather than a second copy — the constructor's
statement budget is spent, and a second array would be the twin
problem inside one class. Pinned in `session-api.test.ts`
("toAuthFailure": the default vocabulary, the injected one, the
non-`HttpError` and off-vocabulary `null`s, and — thrown from
`doAuthenticate` — that the narrowed error is what arms the login
backoff while an off-vocabulary rejection arms nothing) and in
`resilience-policies.test.ts` (the policy's two ownership tables).

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

**The sign-in epilogue is gated on the SIGN-IN, not only on the
sign-out.** `authenticate` captured the logOut epoch and `#finishLogin`
tested it alone — which answers "did a sign-out land after me?" and was
used to answer "is what I stored still current?". The two diverge the
moment ANOTHER sign-in is accepted after this one started, and nothing
excludes that: an explicit `authenticate` sits outside the
`resumeSession` memo and outside the backoff gate by design. Two shapes
followed, both after `authenticate` had reported success — an account
switch silently reverted to the previous pair, and with a logOut in
between the stale flight's epilogue DELETED the session and both
credentials the newer sign-in had just established. Since 1.5.0 ONE method settles
it — `#settleAcceptedSignIn` — on two independent questions, in this
order. A SIGN-OUT landed while the flight was in the air:
`doAuthenticate` has just re-established a session the user asked to
end, so it is cleared — UNLESS a sign-in has CLAIMED the session since
that sign-out (`#hasAcceptedSinceLogOut`, reset by every `logOut`), in
which case clearing would destroy what the claimant established.
Checking supersession FIRST instead gets this wrong: a later sign-in
that starts and is then REFUSED would leave the superseded flight's
session standing behind an explicit sign-out — pinned by its own clause.
Otherwise, a later sign-in STARTED: it is the user's more recent
intention and owns the stored pair, whichever of the two the server
answered first. START order (`#signInSequence`), never acceptance order
— a background resume that began first can be answered LAST, and a
guard counting acceptances would suppress the explicit sign-in's
epilogue instead of the resume's, also pinned. `#finishLogin` no longer
takes the epoch: the verdict lives in one place now. A superseded flight
still RESOLVES: the server accepted its pair and nothing failed. What NO epilogue can undo is the
session store — `doAuthenticate` replaces it wholesale, so a stale
flight resolving last leaves its own material there; the next request
settles it, serving or answering 401 and re-authenticating over the
stored pair, which is the newer one. Both shapes are pinned by clauses
that hold one sign-in open on a gate.

**`ensureSession`'s single flight excludes the refresh's OWN traffic,
or it awaits itself.** `performSessionRefresh` signs in, and the
enforced post-auth registry sync that follows issues requests — each of
which passes back through `ensureSession`. Joining the in-flight handle
there awaits the very promise that is waiting on it: every request on
the client hangs forever, with nothing logged and no timeout to end it.
What had been keeping it alive was only that `needsSessionRefresh()`
usually reads `false` by then; a session whose expiry cannot be parsed
(Classic's schema accepts any string, the ASP.NET `0001-01-01` sentinel
included) keeps it `true` and closes the loop. Since 1.5.0 `#refresh`
runs `performSessionRefresh` inside a per-instance
`AsyncLocalStorage`, and `ensureSession` returns early when it finds
itself inside that scope. The store is per INSTANCE, never per module:
two clients share a process, and one's refresh must never excuse the
other's requests from their own gate. Pinned by a clause that re-enters
`ensureSession` from the refresh after one microtask — the shape the
wire round-trip produces — and which hangs to the suite timeout without
the guard.

**The backoff gate owes itself one retry, because refusing costs a
heartbeat.** `#attemptResumeSession` returns early when
`#isLoginBackedOff()` reads true, WITHOUT a wire call — so no sync cycle
runs, and `planNext()` in the cycle epilogue is the only thing that ever
arms the auto-sync timer. A boot that lands inside the window therefore
armed nothing at all and stayed dormant for the life of the process,
having emitted `onAuthenticationLost` it could never retract, with not
one line in the log to explain the silence (both apps' only heartbeat is
this timer: neither issues a periodic read of its own). Since 1.4.0 the
refusal schedules ONE `DisposableTimeout` at the deadline the gate
already knows and says so at `log` level. It is idempotent — a window is
deferred once — and it rearms from `#reportResumeFailure`, because the
deferred retry can itself be rejected and arm a fresh window. A
transport blip arms no window, so it schedules nothing. The timer is
cleared by `logOut`, by `#finishLogin` (an accepted sign-in ends the
pause, so letting the retry fire would spend a round-trip against the
endpoint the upstream throttles hardest) and by `[Symbol.dispose]`, and
unrefs itself, so it can neither outlive an explicit sign-out nor hold a
process open. The DELAY is bounded by `LOGIN_BACKOFF_THROTTLE_MS`, not
taken from the deadline whole: `setTimeout` clamps anything above
2^31-1 ms to ONE tick, so a corrupt persisted deadline far enough out
would fire the retry immediately, find the gate still shut and
re-schedule — a hot loop. Bounding it re-checks an absurd deadline at
the longest horizon the code can legitimately arm, the same principle
that already reads a non-numeric deadline as no pause at all.

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

- **`requestData`, `safeRequest`, `classifyError`, the `Result`
  type.** They sit on the zod/Result boundary and would drag zod's type
  surface into this package's `.d.ts`; the standing verdict above
  refuses a zod entry. (`normalizeUnauthorized` was filed here until
  1.3.0 although it never touched that boundary — it is the
  `toAuthFailure` template helper now, see the seam paragraph above.)
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

## The `syncDevices` decorator — factory form, generic, 1.3.0

`src/decorators/sync-devices.ts` is the post-method sync notification
both SDKs carried beside `setting`, and the one place they had DRIFTED
in shape: melcloud's was a factory forwarding `{ type }`
(`@syncDevices()`, `@syncDevices({ type })`), heatzy's a bare decorator
forwarding nothing (`@syncDevices`). The concern is one — await the
method, then call the host's `notifySync`, which is `SessionAPI`'s and
already generic in `TSyncParams` — so the core carries melcloud's
factory form, generic over the payload (`syncDevices<TParams>(params?)`),
forwarding `params` verbatim to a structural host
`{ notifySync?: (params?: TParams) => Promise<void> }` (`HasNotifySync`,
unexported like `HasSettingManager` and listed in typedoc's
`intentionallyNotExported`). Two verdicts the spelling records:

- **The returned method carries the host contract in its `this` type**,
  where the twins erased it behind a `this`-less return annotation. The
  family's `no-unnecessary-type-parameters` rule refuses a type
  parameter used once, and the second use is that `this`: it types the
  body and a suite's `.call(host)`, and nothing more. Probed
  2026-09-07 before writing this down — a host whose `notifySync` takes
  another shape, a host with no hook at all and a mismatched payload
  all pass the native compiler (a TC39 application compares the
  decorator's return against the method's own type, which carries no
  `this`). The contract is structural and documented, NOT enforced at
  the application site — exactly its standing in both twins. The
  default is `never`, not `unknown`, so that a suite handing a typed
  `notifySync` to a bare `syncDevices()` through `.call` fits under
  strict function types; `unknown` would refuse every typed hook there.
- **The payload is forwarded verbatim, `undefined` included.**
  melcloud's copy forwarded `{ type }` even when built bare (an object
  with an `undefined` `type`); the core forwards what it was built
  with, so a kernel clause asserting
  `toHaveBeenCalledWith({ type: undefined })` is the adoption's to
  reword (`toHaveBeenCalledWith(undefined)`, or `@syncDevices({})` at
  the call site).

heatzy's adoption is its MAJOR: its three call sites become
`@syncDevices()` and the decorator it re-exports changes shape. Pinned
in `tests/unit/sync-devices-decorator.test.ts` — order (target first,
then notify), verbatim forwarding, the bare form, the hook-less host,
propagation of a rejecting hook, no notification on a rejecting method,
and a real TC39 application through the swc plugin with both forms on
one typed host.

## Runtime floors

- **Engines: `>=22.20.0`, derived, not copied.** The floor is the
  highest of: what the code needs (iterator helpers in the redaction
  engine — Node 22), what the dependency tree demands
  (`temporal-polyfill` declares no floor), and where the code RUNS —
  this package ships inside the SDKs, which install as production
  dependencies of the Homey apps, whose measured device floor is Node
  22.20. Re-derive on change; never copy a sibling's number blindly.
- **`.nvmrc` is the INSTALL floor — 22.22.2 — not the engines floor,
  and it is derived in configs, not here.** It names the lowest Node
  the toolchain configs pulls into every consumer installs on
  (`eslint-plugin-package-json` requires `^22.22.2 || >=24.15.0`;
  configs' own `engines` states the same value, and its CLAUDE.md
  carries the derivation). `engines` above keeps the device floor,
  because that is what the CODE needs where it runs; a fresh clone on
  22.20 would run the package but cannot `npm ci` its dev tree, which
  is the one thing `.nvmrc` must tell it. One rule for the four
  libraries since the configs 5.0.0 adoptions (2026-09-07); it moves
  when configs re-derives it, never by hand here.
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

### Exports with no external consumer — verdict, 2026-09-05, re-counted 2026-09-07

Audited after both 2026-09-04 adoptions, and re-counted on 2026-09-07
against every `{…} from '@olivierzal/api-core…'` import block in the
family AS THE SDKs' AUDIT SWEEPS LEAVE THEM (heatzy-api #1240 makes
`HeatzyAPIConfig` extend `SessionAPIConfig`; melcloud-api #1765 drops
the last importers of `APICallLogData` and `LoggableRequestConfig`) —
the two SDKs are the only repos that pin the package (both at 1.2.0);
the apps reach it through them, and the `fireAndForget` they import
comes from `@olivierzal/homey-kit`, not from here. The root barrel
exports 69 names, 44 values and 25 types (1.3.0 added `ValidationError`
and `syncDevices`, both bound by the SDKs' 1.3.0 adoptions and neither
counted below); 22 of them — fifteen values, seven types — have NO
external importer, through the root or through a subpath:

- The fifteen values: the policy toolkit (`AuthRetryPolicy`,
  `CompositePolicy`, `RateLimitPolicy`, `TransientRetryPolicy`, the
  retry-backoff surface `withRetryBackoff` /
  `DEFAULT_TRANSIENT_RETRY_OPTIONS`, and `DisposableTimeout`), the base
  redaction pair (`BASE_SENSITIVE_KEYS`, `baseRedaction`),
  `APICallLogData`, `SyncManager`, `LifecycleEmitter`, `fireAndForget`
  (root and `/fire-and-forget` subpath alike), `formatDurationHuman`
  and `isTransientServerError`. `SessionAPI` — or a seat it builds —
  constructs or calls every one of them, and both SDKs reach them only
  through it. `LifecycleEmitter` could not be trimmed even if wanted: it
  types the protected `events` member, so the emitted `.d.ts` names it.
  (`RateLimitGate` types the protected `rateLimitGate` the same way but
  is NOT on this list — melcloud-api's `rate-limit-gate.ts` imports it.)
- The seven types: `SessionAPIOptions`, `APICallLogDataWithErrorMessage`,
  `LoggableRequestConfig`, `RateLimitDurationLike`, `ResiliencePolicy`,
  `RetryBackoffOptions`, `RetryTelemetry`. Each names a parameter or
  return of an exported signature (the `SessionAPI` constructor,
  `createAPICallErrorData`, the request-log shells, the `RateLimitGate`
  / `TransientRetryPolicy` / `CompositePolicy` constructors,
  `withRetryBackoff`), so a consumer spelling those signatures out needs
  the name. `SessionAPIConfig` left the list on 2026-09-07: heatzy-api's
  public config type extends it.

They STAY exported: an unconstructed export costs a consumer nothing, a
host composing its own client outside `SessionAPI` may want exactly
these pieces, and trimming them would be a major for nothing.
`api-surface.test.ts` pins the WHOLE 44-name value surface, not this
subset — an accidental drop of any value export fails there — and no
test pins the type exports: the eighteen imported ones are held by the
consumers' adoption typechecks, the seven above by this ledger alone.
This verdict exists so a future audit reads a decision here instead of
re-deriving one; when the barrel changes, re-count it — never trim it.
The `./testing` subpath is outside this ledger: a separate entry the
root barrel never re-exports, whose importers are the SDKs' suites, not
their code.

## The `./testing` subpath — verdict 2026-09-07, shipped in 1.3.0

`src/testing/index.ts` owns the test helpers the two SDK suites and
this package's own carried as a three-way hand-maintained twin
(`cast`, `defined`, `mock`, `createLogger`, `createSettingStore`,
`createMockHttpClient`, `mockFetchResponse`, `createHttpError` /
`createServerError` / `createUnauthorizedError`,
`mockTemporalNowInstant` / `mockTemporalNowZoned`), published as
`@olivierzal/api-core/testing` and consumed by this repo's suites from
`src/testing/index.ts` — `tests/helpers.ts` is gone. The 2026-09-06
audit had DEFERRED the subpath (it ships vitest-importing code through
a production dependency onto the apps' device trees, and couples every
helper tweak to a release plus two pin-bump PRs); the family's breaking
wave accepted that cost, for the reason the twin discipline already
failed once at the top of this file: the `mockTemporalNowInstant`
native-Temporal fake-timer trap is exactly the fix that must reach
every copy, and heatzy's `mockFetchResponse` had already drifted from
the other two.

Four rules hold the seat:

- **`vitest` is imported and declared nowhere** — no dependency, no
  peer, optional or not. The SDKs install this package as a PRODUCTION
  dependency of the Homey apps, and homey-kit measured what an optional
  `vitest` peer does there: 39 packages and 39 MB of test framework on
  a Homey, vulnerabilities included (`npm ci --omit=dev` still installs
  a recorded optional peer). The consumer already holds vitest as a
  devDependency; a missing one fails loudly at the import, in a dev
  context. `eslint.config.ts` carries the homey-kit overlay that admits
  the devDependency import under `src/testing/**` alone.
- **The root barrel never re-exports it.** A production import of
  `@olivierzal/api-core` must not load vitest; `export-map.test.ts`
  keeps `testing` out of `DIRECTORY_REEXPORTS` and resolves the subpath
  to its directory's `index.ts` (the one `index.ts` case in the map);
  typedoc documents it as a second entry point, under its own `Testing`
  category.
- **`mockFetchResponse` nulls the body on 204, 205 and 304** — the
  Fetch spec's null-body statuses the `Response` constructor can build
  at all; it refuses 101 and 103 outright (outside its 200–599 range,
  measured on Node 26.7), so listing them would be dead data. That
  settles the recorded drift: this copy and melcloud's nulled 204 only,
  heatzy's pre-#1240 copy carried the wider set.
- **`createMockHttpClient(clientClass, baseURL)` takes the transport
  CLASS**, because each SDK's transport is its own thin `HttpClient`
  subclass — the one seating its redaction vocabulary and the one its
  `instanceof` resolver accepts (the security-load-bearing verdict
  under "What stayed out"). The helper returns that subclass's type.

Coverage runs over `src/testing` like any other module (100 % on all
four axes, pinned by `tests/unit/testing-helpers.test.ts`), so a helper
is proven here before a consumer inherits it. Adoption is the SDKs'
1.3.0 pin bump: each trims its `tests/helpers.ts` to what is its own
(melcloud's `okValue`, `matchObject`, `mockResponse`; heatzy's
`createMockAdapter`, `mockResponse`) and imports the rest from the
subpath.

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

Auto-merge is never armed on an authored PR (verdict 2026-09-07:
api-core#12 had it armed and merged 13 s before Copilot's review landed,
leaving two threads on a merged PR, one of them real). A PR is merged by
hand, on its FINAL head, once three things hold at once: every check is
SUCCESS or SKIPPED, the Sonar PR window is at zero open issues with the
gate OK, and every review thread is settled. The Dependabot lane
(`.github/workflows/dependabot.yml` arming `gh pr merge --auto` once CI
passes) is the one deliberate exception and stays as documented.

All eleven workflows are stubs calling the family reusables in
`OlivierZal/configs`, pinned `@<sha> # vX.Y.Z` — one version, both
channels: the npm pin and every `uses:` ref move in the same commit,
and `check-pins` fails a mismatch. `publish.yml` and `docs.yml` joined
the stubs with the configs 5.0.0 adoption (`reusable-publish` /
`reusable-docs`, derived from the copies the four libraries had carried
identically — this repo's since the 2026-08-27 seed — minus a dead
`IS_PRERELEASE` env entry): the caller keeps the `release` trigger and
the grants (publish: attestations / id-token / packages write,
contents read; docs: contents and packages read, id-token and pages
write), and the `npm` and `github-pages` environments travel with the
called jobs. The `setup-node-and-install` composite action stays LOCAL
on purpose — the called jobs run the CALLER's copy — and every install
passes the job `GITHUB_TOKEN` as `npm-token` (the configs dependency
lives on GitHub Packages, where even reads need auth). `docs.yml` also
takes a `workflow_dispatch` with a boolean `dry-run`: the build half
runs, the deploy is skipped — the one rehearsal a release-only path
can get, so dispatch it once after every configs adoption and before
the next release (the deploy half and the `npm` environment stay
unproven until the first release through the reusables — configs
states that residual risk rather than hiding it). The
`use-trusted-publishing` zizmor ignore left with the local
`npm publish` step: a stub carries nothing for that audit to flag.

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
