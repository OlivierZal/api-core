// @ts-check
import { typedocBase } from '@olivierzal/configs/typedoc'

/** @type {Partial<import('typedoc').TypeDocOptions>} */
const config = typedocBase({
  categoryOrder: ['HTTP', 'Configuration', 'Errors', 'Types'],
  // Single-barrel shape like melcloud-api: the flat subpaths of the
  // exports map re-export symbols the root barrel already documents,
  // so they add no reflection of their own.
  hostedBaseUrl: 'https://olivierzal.github.io/api-core/',
  name: 'API Core',
  navigationLinks: {
    GitHub: 'https://github.com/OlivierZal/api-core',
    'GitHub Packages':
      'https://github.com/OlivierZal/api-core/pkgs/npm/api-core',
  },
})

export default config
