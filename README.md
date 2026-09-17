# @olivierzal/api-core

Shared API-client core for the OlivierZal SDKs (`melcloud-api`,
`heatzy-api`): the session lifecycle and request pipeline
(`SessionAPI`, which both SDKs subclass), the redaction-seated HTTP
client, the observability shells, and the resilience primitives — the
MECHANISM the SDKs used to carry as byte-identical twins. The protocol vocabularies (sensitive-key
sets, wire types, status semantics) stay in each consumer and are
INJECTED here, never owned.

[![License](https://img.shields.io/github/license/OlivierZal/api-core)](LICENSE)
[![Node](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FOlivierZal%2Fapi-core%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&color=brightgreen)](package.json)
[![GitHub release](https://img.shields.io/github/v/release/OlivierZal/api-core?sort=semver)](https://github.com/OlivierZal/api-core/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/OlivierZal/api-core/ci.yml?branch=main&label=CI)](https://github.com/OlivierZal/api-core/actions/workflows/ci.yml)
[![CodeQL](https://github.com/OlivierZal/api-core/actions/workflows/github-code-scanning/codeql/badge.svg?branch=main)](https://github.com/OlivierZal/api-core/security/code-scanning)

[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=OlivierZal_api-core&metric=alert_status)](https://sonarcloud.io/dashboard?id=OlivierZal_api-core)
[![Test coverage](https://sonarcloud.io/api/project_badges/measure?project=OlivierZal_api-core&metric=coverage)](https://sonarcloud.io/component_measures?id=OlivierZal_api-core&metric=coverage)
[![Docs coverage](https://olivierzal.github.io/api-core/coverage.svg)](https://olivierzal.github.io/api-core/)

## Install

The package lives on GitHub Packages:

```ini title="npmrc"
@olivierzal:registry=https://npm.pkg.github.com
```

```sh title="install"
npm install @olivierzal/api-core
```

Pin it exactly — adoption of a new version is a reviewed PR, never a
range.

## Subpaths

| Import                                 | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@olivierzal/api-core`                 | Everything: `HttpClient`/`HttpError`/`HttpStatus` and `readHeaders`, the redaction engine (`createRedaction`, `BASE_SENSITIVE_KEYS`, `REDACTED`), the observability shells (`APICallRequestData`, `APICallResponseData`, `createAPICallErrorData`, `LifecycleEmitter`), the resilience primitives, `SessionAPI` + `SyncManager`, the errors `APIError`/`AuthenticationError`/`AuthenticationThrottledError`/`RateLimitError`/`RegistrySyncError`/`ValidationError` and the guards `isAPIError`/`isHttpError`, the `setting` accessor decorator and the `syncDevices` method decorator factory, `LoginCredentials`, the lifecycle types — plus a re-export of the three flat subpath modules below (never `./testing`) |
| `@olivierzal/api-core/fire-and-forget` | `fireAndForget` — the one sanctioned detach-and-log seam                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `@olivierzal/api-core/temporal`        | `Temporal` + `Intl` — the single `temporal-polyfill` entry point                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `@olivierzal/api-core/testing`         | The vitest-backed helpers the SDK suites share — `cast`, `defined`, `mock`, `createLogger`, `createSettingStore`, `createMockHttpClient`, `mockFetchResponse`, the `HttpError` factories, the `Temporal` clock spies. Imports `vitest` from YOUR devDependencies; never re-exported by the root barrel                                                                                                                                                                                                                                                                                                                                                                                                                |
| `@olivierzal/api-core/time-units`      | `MS_PER_SECOND`, `MS_PER_MINUTE`, `MS_PER_DAY`, `SESSION_REFRESH_AHEAD_MS`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

`setting` persists a decorated accessor through your host's
`SettingManager`, under a key that IS the accessor's name — renaming
the accessor renames the stored key and strands the value ([the rule
and its probe](CLAUDE.md)). `syncDevices(params?)` is the method
decorator factory that awaits the decorated method, then calls the
host's `notifySync(params)` — `@syncDevices({ type })` forwards the
payload, `@syncDevices()` notifies without one; the host's `notifySync`
is a structural contract.

## The vocabulary seam

Every redaction seat takes a `Redaction` engine built from YOUR wire's
credential keys. The base vocabulary (`authorization`, `cookie`,
`set-cookie`, `password`, `username`, `email`, `token`) always applies;
`createRedaction` unions your keys on top, so extending can only ever
redact MORE:

```ts title="wiring"
import {
  AuthRetryPolicy,
  createRedaction,
  HttpClient,
  HttpStatus,
  RetryGuard,
} from '@olivierzal/api-core'

// One engine per SDK, seeded with its protocol's credential keys.
const redaction = createRedaction(['x-mitscontextkey', 'contextkey'])

// Every HttpError this client throws carries a snapshot redacted
// through that vocabulary — request headers/body/params/url-query and
// response headers/body alike, at construction, not at log time.
const client = new HttpClient({
  baseURL: 'https://api.example.com',
  redaction,
  timeout: 30_000,
})

// A wire that reports an expired token as 400 injects its statuses.
const authRetry = new AuthRetryPolicy(
  new RetryGuard(60_000),
  async () => resumeSession(),
  [HttpStatus.Unauthorized, HttpStatus.BadRequest],
)
```

Constructing an `HttpError`, `APICallRequestData`,
`APICallResponseData` or `createAPICallErrorData` directly? Pass the
same engine. Without one, the base vocabulary applies — generic
carriers are always covered, protocol keys only where injected.

## The session seam

`SessionAPI` is the abstract session lifecycle and request pipeline:
persisted credentials, the login-backoff gate, single-flight session
refresh, the resilience pipeline around every request, and the
sync-cycle template. Extend it, hand it what your protocol knows, and
implement the twelve hooks (`doAuthenticate`, `getAuthHeaders`,
`isAuthenticated`, `syncRegistry`, `enforceRegistrySync`, …):

```ts title="session"
class MyAPI extends SessionAPI<MySyncParams> {
  public constructor(config: MyConfig = {}) {
    super(config, {
      // YOUR resolver, YOUR HttpClient subclass — the core takes the
      // transport already built, so a host-supplied client is judged
      // against the class that seats your redaction vocabulary.
      transport: buildTransport(config.transport),
      defaultSyncIntervalMinutes: 5,
      syncCallback: async () => this.fetch(),
      // Omit `rateLimitHours` for a wire that has never sent a 429;
      // omit `logLabel` when one client per host needs no prefix.
      authFailureStatuses: [HttpStatus.Unauthorized, HttpStatus.BadRequest],
    })
  }

  protected override async doAuthenticate(
    credentials: LoginCredentials,
  ): Promise<void> {
    try {
      await this.login(credentials)
    } catch (error) {
      // The same statuses, spelled once: a rejection on them becomes
      // the shared AuthenticationError (cause preserved); anything
      // else is rethrown verbatim — as a BARE `throw error`, the
      // catch-clause rethrow `only-throw-error` admits (a `?? error`
      // one-liner is typed `unknown` there and refused).
      const authError = this.toAuthFailure(
        error,
        'Vendor rejected the credentials',
      )
      if (authError !== null) {
        throw authError
      }
      throw error
    }
  }
}
```

The four settings it persists are named by their accessors — `expiry`,
`loginBackoffUntil`, `password`, `username` — so a host that already
holds those keys keeps its stored values.

A failure that repeats is ONE event in your log. Whatever cadence your
client polls on, a call that keeps failing and a registry cycle that
keeps failing are each reported when the streak opens, when its reason
changes, and at most every five minutes while it stands; the recovery
is one line naming how many failures the streak counted, the one
that opened it included
(`GET /devices answered again after 42 failed attempts`). Override the
protected `logError` when a dialect must silence a line entirely.

## Testing

The helpers every SDK suite used to copy come from the `./testing`
subpath — it imports `vitest` from your devDependencies and is never
re-exported by the root barrel:

```ts title="testing"
import {
  createMockHttpClient,
  createSettingStore,
  mockTemporalNowInstant,
} from '@olivierzal/api-core/testing'

// YOUR HttpClient subclass, so the spy-wrapped transport is the one
// your resolver accepts.
const { client, requestSpy } = createMockHttpClient(HttpClient, baseURL)
```

## Docs

Full API reference: <https://olivierzal.github.io/api-core/>.

Maintainer doctrine lives in [`CLAUDE.md`](CLAUDE.md) — including why
this package exists (the 2026-08-21 twin-divergence leak) and what may
enter it.
