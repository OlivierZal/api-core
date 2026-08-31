import { webviewFloorBlock } from '@olivierzal/configs/eslint'
import { library } from '@olivierzal/configs/eslint/library'
import { type Config, defineConfig } from 'eslint/config'

// The consumer-bundleable leaves: the flat subpath modules a consuming
// SDK's own webview-reachable closure can re-export (melcloud-api's
// `/temporal` does, and its flat modules may import the time units).
// The deep mechanism layers (http, observability, resilience, api,
// errors) are node-only in every consumer and keep the modern-API
// freedom the device Node allows (the redaction engine uses iterator
// helpers).
const WEBVIEW_FLOOR_FILES = [
  'src/fire-and-forget.ts',
  'src/temporal.ts',
  'src/time-units.ts',
]

const config: Config[] = defineConfig([
  // `.claude/` holds agent-session worktrees (checkouts of this very
  // repo): linting them double-reports every file and fails dependency
  // resolution from the nested root.
  { ignores: ['.claude/', 'coverage/', 'dist/', 'docs/'] },
  ...library({
    wireNamingEntries: [
      // HTTP names its statuses through reason phrases (IANA HTTP
      // Status Code Registry); the SDK family's status map keys them.
      {
        filter: {
          match: true,
          regex:
            '^(BadGateway|BadRequest|GatewayTimeout|NotFound|ServiceUnavailable|TooManyRequests|Unauthorized)$',
        },
        format: ['PascalCase'],
        selector: 'objectLiteralProperty',
      },
    ],
    wireNamingFiles: ['src/http/status.ts'],
  }),
  webviewFloorBlock(WEBVIEW_FLOOR_FILES),
  {
    // Shipped regexes stay on the `u` flag: the consuming SDKs are
    // bundled INTO their apps' phone webviews, and the worst engine
    // the Homey app admits, iOS 16.4's WebKit (App Store minimum,
    // read 2026-08-11), predates the `v` flag — an escapee ships as a
    // `new RegExp` call under the apps' sub-es2024 esbuild target and
    // throws at runtime. Scoping to the reachable subset is
    // unmaintainable, so all of `src` holds the floor until the App
    // Store minimum reaches 17.4 (melcloud-api pins the same rule for
    // the same reason).
    files: ['src/**/*.ts'],
    rules: { 'require-unicode-regexp': ['error', { requireFlag: 'u' }] },
  },
])

export default config
