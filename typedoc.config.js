// @ts-check
import { typedocBase } from '@olivierzal/configs/typedoc'

const shared = typedocBase({
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

// A consumer of this package subclasses `SessionAPI`: the protected
// hooks and helpers are the surface it writes against, so the
// reference emits them (`excludeProtected`) and displays them from the
// first visit (`visibilityFilters`: the theme hides protected members
// until the reader ticks "Protected", and the option replaces its
// default object whole, hence the three other keys). The shared preset
// hides protected members, which suits a package nobody subclasses.
/** @type {Partial<import('typedoc').TypeDocOptions>} */
const config = {
  ...shared,
  excludeProtected: false,
  visibilityFilters: {
    external: false,
    inherited: true,
    private: false,
    protected: true,
  },
}

export default config
