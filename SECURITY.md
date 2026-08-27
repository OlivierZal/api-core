# Security policy

If you discover a security vulnerability in this package, please report it
privately via [GitHub security advisories](https://github.com/OlivierZal/api-core/security/advisories/new)
instead of opening a public issue.

Only the latest published release receives security updates.

## What this package is, for triage

This package is the shared core of the `@olivierzal` API SDKs
(`melcloud-api`, `heatzy-api`), which install as **production
dependencies** of Homey apps: its published output executes on end-user
hardware, inside the app process, handling the account credentials
those SDKs authenticate with.

Three consequences for a report:

- **The redaction engine is a security mechanism.** `HttpError`
  snapshots, API call log lines and diagnostic reports all pass through
  it; a bypass — a carrier field it misses, a casing it fails to match,
  an encoding (JSON text, form-encoded body, URL query) it does not
  walk — is a credential-disclosure vulnerability, not a logging bug.
  This is exactly the class of the 2026-08-21 incident that created
  this package.
- A vulnerability here reaches **every consumer at once** — that is the
  point of the extraction, and it cuts both ways. Fixes ship as a
  release plus a pin bump in each SDK; report privately so the window
  between disclosure and adoption stays closed.
- The package declares **one runtime dependency**
  (`temporal-polyfill`). Reports about other transitive risk are best
  directed at the consuming SDK or app, which owns the rest of its
  tree.
