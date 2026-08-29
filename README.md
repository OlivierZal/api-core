# @olivierzal/api-core

Shared API-client core for the OlivierZal SDKs (`melcloud-api`,
`heatzy-api`): the redaction-seated HTTP client, the observability
shells, and the resilience primitives — the MECHANISM the SDKs used to
carry as byte-identical twins. The protocol vocabularies (sensitive-key
sets, wire types, status semantics) stay in each consumer and are
INJECTED here, never owned.

[![License](https://img.shields.io/github/license/OlivierZal/api-core)](LICENSE)
[![Node](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FOlivierZal%2Fapi-core%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&color=brightgreen)](package.json)
[![GitHub release](https://img.shields.io/github/v/release/OlivierZal/api-core?sort=semver)](https://github.com/OlivierZal/api-core/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/OlivierZal/api-core/ci.yml?branch=main&label=CI)](https://github.com/OlivierZal/api-core/actions/workflows/ci.yml)

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

| Import                                 | Contents                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@olivierzal/api-core`                 | Everything: `HttpClient`/`HttpError`/`HttpStatus`, the redaction engine (`createRedaction`, `BASE_SENSITIVE_KEYS`, `REDACTED`), the observability shells (`APICallRequestData`, `APICallResponseData`, `createAPICallErrorData`, `LifecycleEmitter`), the resilience primitives, `SessionAPI` + `SyncManager`, `APIError`/`AuthenticationError`/`AuthenticationThrottledError`/`RateLimitError`, the `setting` accessor decorator, `LoginCredentials`, the lifecycle types |
| `@olivierzal/api-core/fire-and-forget` | `fireAndForget` — the one sanctioned detach-and-log seam                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `@olivierzal/api-core/temporal`        | `Temporal` + `Intl` — the single `temporal-polyfill` entry point                                                                                                                                                                                                                                                                                                                                                                                                           |
| `@olivierzal/api-core/time-units`      | `MS_PER_SECOND`, `MS_PER_MINUTE`, `MS_PER_DAY`, `SESSION_REFRESH_AHEAD_MS`                                                                                                                                                                                                                                                                                                                                                                                                 |

`setting` persists a decorated accessor through your host's
`SettingManager`, under a key that IS the accessor's name — renaming
the accessor renames the stored key and strands the value ([the rule
and its probe](CLAUDE.md)).

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
}
```

The four settings it persists are named by their accessors — `expiry`,
`loginBackoffUntil`, `password`, `username` — so a host that already
holds those keys keeps its stored values.

## Docs

Full API reference: <https://olivierzal.github.io/api-core/>.

Maintainer doctrine lives in [`CLAUDE.md`](CLAUDE.md) — including why
this package exists (the 2026-08-21 twin-divergence leak) and what may
enter it.
