// @ts-check
import { typedocBase } from '@olivierzal/configs/typedoc'

/** @type {Partial<import('typedoc').TypeDocOptions>} */
const config = typedocBase({
  // `API` first, matching the consumers' `API Clients` slot: `SessionAPI`
  // is the seam a reader opens these docs for. An omitted category is
  // not an error — typedoc just appends it after the listed ones — so
  // this list has to be extended by hand whenever a new `@category`
  // lands.
  categoryOrder: [
    'API',
    'HTTP',
    'Configuration',
    'Errors',
    'Decorators',
    'Testing',
    'Types',
  ],
  // Two entries, not one: the flat subpaths of the exports map re-export
  // symbols the root barrel already documents (melcloud-api's
  // single-barrel shape), but `./testing` is a directory subpath the
  // root barrel never re-exports — it imports vitest — so it is
  // documented as an entry of its own (the homey-kit shape).
  entryPoints: ['src/index.ts', 'src/testing/index.ts'],
  hostedBaseUrl: 'https://olivierzal.github.io/api-core/',
  intentionallyNotExported: [
    // Internal infrastructure leaked through the public decorator
    // signatures (tagged `@internal` in source): the `setting` host
    // contract — the core's alone since the SessionAPI extraction;
    // heatzy-api consumes the decorator from here and no longer carries
    // a copy or this entry — and the `syncDevices` host contract beside
    // it.
    'HasNotifySync',
    'HasSettingManager',
  ],
  name: 'API Core',
  navigationLinks: {
    GitHub: 'https://github.com/OlivierZal/api-core',
    'GitHub Packages':
      'https://github.com/OlivierZal/api-core/pkgs/npm/api-core',
  },
})

export default config
