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
    'Types',
  ],
  // Single-barrel shape like melcloud-api: the flat subpaths of the
  // exports map re-export symbols the root barrel already documents,
  // so they add no reflection of their own.
  hostedBaseUrl: 'https://olivierzal.github.io/api-core/',
  intentionallyNotExported: [
    // Internal infrastructure leaked through the public `setting`
    // decorator signature (tagged `@internal` in source); heatzy-api
    // carries the same entry for its own copy.
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
