# @olivierzal/api-core

Shared API-client core for the OlivierZal SDKs
(`@olivierzal/melcloud-api`, `@olivierzal/heatzy-api`): the HTTP client
and the session base class an SDK is built on. You supply what is
specific to your API: how to sign in, which headers carry the session,
which keys are secret.

[![License](https://img.shields.io/github/license/OlivierZal/api-core)](https://github.com/OlivierZal/api-core/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FOlivierZal%2Fapi-core%2Fmain%2Fpackage.json&query=%24.engines.node&label=node&color=brightgreen)](https://github.com/OlivierZal/api-core/blob/main/package.json)
[![GitHub release](https://img.shields.io/github/v/release/OlivierZal/api-core?sort=semver)](https://github.com/OlivierZal/api-core/releases)
[![CI](https://img.shields.io/github/actions/workflow/status/OlivierZal/api-core/ci.yml?branch=main&label=CI)](https://github.com/OlivierZal/api-core/actions/workflows/ci.yml)
[![CodeQL](https://github.com/OlivierZal/api-core/actions/workflows/github-code-scanning/codeql/badge.svg?branch=main)](https://github.com/OlivierZal/api-core/security/code-scanning)

[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=OlivierZal_api-core&metric=alert_status)](https://sonarcloud.io/dashboard?id=OlivierZal_api-core)
[![Test coverage](https://sonarcloud.io/api/project_badges/measure?project=OlivierZal_api-core&metric=coverage)](https://sonarcloud.io/component_measures?id=OlivierZal_api-core&metric=coverage)
[![Docs coverage](https://olivierzal.github.io/api-core/coverage.svg)](https://olivierzal.github.io/api-core/)

## Features

- An HTTP client over `fetch`: JSON in and out, an `HttpError` on any
  non-2xx response, secrets redacted from errors and logs.
- `SessionAPI`, the base class of your client: sign-in, stored session,
  refresh, re-authentication, restore at start-up, sign-out.
- Reads retried up to four times on a transient failure, writes never,
  and optional rate-limit handling.
- Automatic sync of your device registry, and events for the host.
- Typed errors, logs that stay readable when a failure repeats, and
  test helpers for vitest.

## Requirements

- Node.js `>=22.20.0`. The package ships as ES modules only.
- A GitHub token with the `read:packages` scope, to install from GitHub
  Packages.
- Standard decorators, not `experimentalDecorators`, for `@setting` and
  `@syncDevices()`.

## Installation

The package is published to GitHub Packages, not the public npm
registry. Point the `@olivierzal` scope at it, with the token in
`NODE_AUTH_TOKEN`:

```ini title=".npmrc"
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
@olivierzal:registry=https://npm.pkg.github.com
```

Then install the package at an exact version:

```sh title="install"
npm install --save-exact @olivierzal/api-core
```

Import from `@olivierzal/api-core`, which uses Node built-ins. Three
modules that use none are also entry points of their own, for a
browser bundle: `@olivierzal/api-core/fire-and-forget`
(`fireAndForget`), `@olivierzal/api-core/temporal` (`Temporal` and
`Intl`) and `@olivierzal/api-core/time-units` (`MS_PER_SECOND`,
`MS_PER_MINUTE`, `MS_PER_DAY` and `SESSION_REFRESH_AHEAD_MS`). The test
helpers are in `@olivierzal/api-core/testing`.

## Quick start

Extend `SessionAPI`, hand it an `HttpClient` and implement its twelve
hooks. This client signs in for a token, lists device ids and switches
a device on or off:

```ts title="quick-start"
import {
  type LoginCredentials,
  type SessionAPIConfig,
  createRedaction,
  HttpClient,
  isSessionExpired,
  SESSION_REFRESH_AHEAD_MS,
  SessionAPI,
  setting,
} from '@olivierzal/api-core'

const redaction = createRedaction(['x-vendor-token'])
const transport = new HttpClient({
  baseURL: 'https://api.vendor.example',
  redaction,
  timeout: 30_000,
})

export class VendorAPI extends SessionAPI {
  public deviceIds: readonly string[] = []

  @setting
  private accessor token = ''

  public constructor(config: SessionAPIConfig = {}) {
    super(config, { defaultSyncIntervalMinutes: 5, redaction, transport })
  }

  public isAuthenticated(): boolean {
    return this.token !== ''
  }

  public async setPower(id: string, isOn: boolean): Promise<void> {
    await this.request('post', `/devices/${id}`, { data: { isOn } })
  }

  protected clearPersistedSession(): void {
    this.token = ''
    this.expiry = ''
  }

  protected clearRegistry(): void {
    this.deviceIds = []
  }

  protected async doAuthenticate(credentials: LoginCredentials): Promise<void> {
    try {
      const { data } = await this.dispatch<{ expiry: string; token: string }>(
        'post',
        '/login',
        { authenticated: false, data: credentials },
      )
      this.token = data.token
      this.expiry = data.expiry
    } catch (error) {
      const authError = this.toAuthFailure(error, 'Credentials rejected')
      if (authError !== null) {
        throw authError
      }
      throw error
    }
  }

  protected async enforceRegistrySync(): Promise<void> {
    await this.#refreshDevices()
  }

  protected getAuthHeaders(): Record<string, string> {
    return this.token === '' ? {} : { 'x-vendor-token': this.token }
  }

  protected hasPersistedSession(): boolean {
    return this.token !== ''
  }

  protected needsSessionRefresh(): boolean {
    return isSessionExpired(this.expiry, SESSION_REFRESH_AHEAD_MS)
  }

  protected async performSessionRefresh(): Promise<void> {
    await this.resumeSession()
  }

  protected async reauthenticate(): Promise<boolean> {
    this.clearPersistedSession()
    return this.resumeSession()
  }

  protected reuseSucceeded(): boolean {
    return this.isAuthenticated()
  }

  protected async syncRegistry(): Promise<void> {
    await this.runBestEffortSyncCycle(async () => this.#refreshDevices())
  }

  async #refreshDevices(): Promise<readonly string[]> {
    return this.runSyncCycle(async () => {
      const { data } = await this.request<string[]>('get', '/devices')
      this.deviceIds = data
      return data
    })
  }
}

// What a host does with it.
const api = new VendorAPI()
await api.start()
if (!api.isAuthenticated()) {
  await api.authenticate({ password: 'secret', username: 'user@example.com' })
}
await api.setPower('device-1', true)
```

The first constructor argument comes from the host, the application
that uses your client (`SessionAPIConfig`): `settingManager`, `logger`,
`syncIntervalMinutes`, `abortSignal` and `events`, callbacks for each
request, a lost or restored session and each sync your subclass
notifies. The second is yours (`SessionAPIOptions`): `transport` and
`defaultSyncIntervalMinutes`, and optionally `redaction`,
`authFailureStatuses`, `isAuthFailure`, `rateLimitHours` and `logLabel`.

## Usage

### Implement the hooks

The API reference documents each hook and helper in full. In short,
the twelve hooks you implement:

| Hook                          | What it must do                                                                                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `isAuthenticated()`           | Say whether a session is usable, from local state alone. The only public hook.                                                                                                     |
| `getAuthHeaders()`            | Return the headers that carry the session.                                                                                                                                         |
| `doAuthenticate(credentials)` | Sign in. On success, replace the whole stored session; on failure, store nothing and throw.                                                                                        |
| `clearPersistedSession()`     | Clear every stored session value, such as the token and its expiry.                                                                                                                |
| `clearRegistry()`             | Empty the device registry, so that a signed-out client exposes nothing.                                                                                                            |
| `hasPersistedSession()`       | Say whether a stored session is worth trying at start-up.                                                                                                                          |
| `reuseSucceeded()`            | Say whether that attempt left a usable session.                                                                                                                                    |
| `needsSessionRefresh()`       | Say whether the session must be refreshed before the next request.                                                                                                                 |
| `performSessionRefresh()`     | Refresh it. An error fails the request that triggered the refresh.                                                                                                                 |
| `reauthenticate()`            | Recover after the server refused the session. Resolving `true` replays the request once.                                                                                           |
| `syncRegistry()`              | Refresh the registry without throwing. Runs at start-up, when a stored session is tried, and on every automatic sync.                                                              |
| `enforceRegistrySync()`       | Refresh the registry and let a failure propagate. Runs after an accepted sign-in: if it fails, `authenticate()` rejects with a `RegistrySyncError` and the client stays signed in. |

What your subclass uses:

| Helper                                   | What it is for                                                                                                                                                         |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `request(method, url, config?)`          | Send a request with the session, as the next section describes. `config` takes `data`, `params`, `headers` and `idempotent`.                                           |
| `dispatch(method, url, config?)`         | Send one request with no refresh and no retry, as `doAuthenticate` needs. `authenticated: false` leaves the session headers off.                                       |
| `toAuthFailure(error, message)`          | Return an `AuthenticationError` when `error` is an `HttpError` with one of your `authFailureStatuses`, `null` otherwise.                                               |
| `runSyncCycle(work)`                     | Wrap every registry refresh in it: it runs the refresh, then schedules the next automatic sync. A refresh run outside it schedules none. A failure is rethrown.        |
| `runBestEffortSyncCycle(cycle)`          | Run a refresh that must not throw: a failure is logged and the result is an empty array.                                                                               |
| `applyCredentials(username?, password?)` | Store credentials without signing in, for `start()` to use.                                                                                                            |
| `expiry`                                 | The stored expiry of the session: a string that `isSessionExpired` reads as an ISO 8601 timestamp. Passing it `SESSION_REFRESH_AHEAD_MS` refreshes five minutes early. |
| `rateLimitGate`                          | The rate-limit pause (`isPaused`), `undefined` without `rateLimitHours`.                                                                                               |
| `logError(error)`                        | Override it to keep an expected failure out of the log. The line written when the endpoint answers again still appears.                                                |
| `@setting`                               | Decorator for a string `accessor`: its value is kept in the host's `settingManager` under the accessor's name, so renaming it leaves the stored value behind.          |
| `@syncDevices()`                         | Decorator for an async method: once it has resolved, it calls `notifySync()`, the only thing that fires the host's `onSyncComplete`. Put it on your registry refresh.  |

### Send requests

- A read (a `GET`, or a request passing `idempotent: true`) is retried
  up to four times on a transient failure: an HTTP 500, 502, 503 or
  504, a network failure or a timeout. The retries wait about 1, 2, 4
  and 8 seconds. A write is never retried on a transient failure.
- A request refused with one of your `authFailureStatuses` (401 by
  default, narrowed by `isAuthFailure` when you pass it) is replayed
  once after `reauthenticate()` resolves `true`.
- With `rateLimitHours`, a 429 puts requests on hold until its
  `Retry-After` has passed, or for that many hours without one:
  meanwhile they reject with a `RateLimitError` instead of being sent.
- A non-2xx response rejects with an `HttpError`, which is not an
  `APIError`: each has its guard, `isHttpError` and `isAPIError`. A
  network failure, a timeout and an abort reject as `fetch` does.

### Sign in and restore the session

`start()` restores the stored session, or else signs in with the
stored credentials through `resumeSession()`. Neither throws on a
failed sign-in, and `resumeSession()` resolves to whether it was
accepted.

After a sign-in that `doAuthenticate` rejects with an
`AuthenticationError`, `resumeSession()` stops signing in for 15
minutes. Throw an `AuthenticationThrottledError` when the API throttles
sign-ins: the pause is then 2 hours, or its `retryAfter` when that is
shorter. The pause is stored like the session, so it survives a restart
when the host passes a `settingManager`, and an explicit
`authenticate()` ignores it. When the stored sign-in fails for another
reason, such as a network failure, `resumeSession()` tries again every
minute.

To keep the session across restarts, the host passes a
`settingManager`: an object with `get(key)`, `set(key, value)` and
optionally `unset(key)`. Without one, values stay in memory. The base
class keeps `username`, `password`, `expiry` and `loginBackoffUntil` in
it, and `authenticate()` writes the credentials, as given, only once
the server accepted them.

When only a new sign-in can restore the session (the stored
credentials were refused, or a stored session ended with none to renew
it), `onAuthenticationLost` fires once and the automatic sync stops
until `authenticate()` succeeds.

### Keep the registry in sync

The registry is refreshed every `syncIntervalMinutes` (the host's
choice) or `defaultSyncIntervalMinutes` (yours); `false` disables the
sync. A write holds the next run back until 3 seconds after it
completes.

### Redact secrets and personal data

`createRedaction(keys, { personalDataKeys })` takes your API's secret
keys and the fields its users type, such as a device name: a field you
do not declare is logged as is. Pass the same engine to your
`HttpClient` and to `SessionAPI`. Seven keys are always redacted:
`authorization`, `cookie`, `email`, `password`, `set-cookie`, `token`
and `username`. A key matches by its whole name, whatever its case, and
its value reads `******` in every `HttpError` and every logged request
and response.

### Read the logs

Lines go to the host's `logger`, `console` by default, prefixed with
`logLabel` when you pass one. Every request and every response is one
line of JSON, in which a body over 4096 bytes reads
`[body omitted: N bytes]`. A request the server refuses, a failed
registry refresh and a session restore that fails for a transient
reason are each logged when the failure starts, when its reason
changes, and at most every 5 minutes while it lasts; one line then
reports the recovery, such as
`GET /devices answered again after 3 failed attempts`. A restore the
server refuses is logged each time it is tried. For your own
lines, `FailureStreaks` applies the same rule, and `logFailure` writes
a failure the package recognises as one line naming its causes.

### Test your client

`@olivierzal/api-core/testing` holds helpers for a vitest suite, with
`vitest` among your own `devDependencies`: doubles for the host's
logger and store (`createLogger`, `createSettingStore`), a transport
with a spy on its `request` (`createMockHttpClient`), what that spy or
a stubbed `fetch` resolves with (`mockHttpResponse`,
`mockFetchResponse`), `HttpError` factories, and
`mockTemporalNowInstant` to make `Temporal.Now.instant()` follow fake
timers.

## API reference

The generated reference lists every exported name, and the protected
hooks and helpers of `SessionAPI`:
<https://olivierzal.github.io/api-core/>. It covers the parts
`SessionAPI` is built from too, for a client that does not extend it.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), and report a problem in the
[issues](https://github.com/OlivierZal/api-core/issues).

## Security

For vulnerability reports, see [SECURITY.md](SECURITY.md).

## Changelog

See the [release notes](https://github.com/OlivierZal/api-core/releases).

## License

[MIT](LICENSE) © Olivier Zalmanski
