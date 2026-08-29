import { describe, expect, it, vi } from 'vitest'

import type { SettingManager } from '../../src/api/index.ts'
import { setting } from '../../src/decorators/index.ts'

// The storage keys the consuming SDKs already persist under. The
// decorator derives its key from the ACCESSOR NAME, so these literals
// are a data-migration contract, not a naming preference: renaming a
// decorated accessor renames its stored key and strands the host's
// previous value. `PINNED_KEYS` is asserted against the keys the mock
// manager actually observes.
const PINNED_KEYS = ['expiry', 'loginBackoffUntil', 'password', 'username']

interface MockStore {
  readonly manager: SettingManager
  readonly reads: string[]
  readonly unsets: string[]
  readonly values: Map<string, string>
  readonly writes: [string, string][]
}

const createStore = ({ hasUnset = true } = {}): MockStore => {
  const values = new Map<string, string>()
  const reads: string[] = []
  const unsets: string[] = []
  const writes: [string, string][] = []
  const base = {
    get: (key: string): string | null => {
      reads.push(key)
      return values.get(key) ?? null
    },
    set: (key: string, value: string): void => {
      writes.push([key, value])
      values.set(key, value)
    },
  }
  return {
    manager: hasUnset
      ? {
          ...base,
          unset: (key: string): void => {
            unsets.push(key)
            values.delete(key)
          },
        }
      : base,
    reads,
    unsets,
    values,
    writes,
  }
}

// A symbol-named accessor: it has no spelling of its own to fall back
// on, so the key it writes under can only come from stringifying
// `context.name`. Declared before the class — a computed accessor name
// is evaluated when the class is defined.
const symbolName = Symbol('token')

// Stands in for a consuming SDK's API class: the accessor names below
// ARE the persisted keys.
class PersistedHost {
  public settingManager?: SettingManager | undefined

  @setting
  public accessor expiry = ''

  @setting
  public accessor loginBackoffUntil = ''

  @setting
  public accessor password = ''

  @setting
  public accessor [symbolName] = ''

  @setting
  public accessor username = ''

  public constructor(settingManager?: SettingManager) {
    this.settingManager = settingManager
  }

  public readAll(): string[] {
    return [this.expiry, this.loginBackoffUntil, this.password, this.username]
  }

  public writeAll(value: string): void {
    this.expiry = value
    this.loginBackoffUntil = value
    this.password = value
    this.username = value
  }
}

describe('setting key derivation', () => {
  it('writes each accessor through the literal key that names it', () => {
    const store = createStore()
    const host = new PersistedHost(store.manager)

    host.expiry = '1'
    host.loginBackoffUntil = '2'
    host.password = '3'
    host.username = '4'

    expect(store.writes).toStrictEqual([
      ['expiry', '1'],
      ['loginBackoffUntil', '2'],
      ['password', '3'],
      ['username', '4'],
    ])
    expect(
      store.values
        .keys()
        .toArray()
        .toSorted((left, right) => left.localeCompare(right)),
    ).toStrictEqual(PINNED_KEYS)
  })

  it('reads each accessor back through the same literal key', () => {
    const store = createStore()
    store.values.set('expiry', 'e')
    store.values.set('loginBackoffUntil', 'b')
    store.values.set('password', 'p')
    store.values.set('username', 'u')
    const host = new PersistedHost(store.manager)

    expect(host.readAll()).toStrictEqual(['e', 'b', 'p', 'u'])
    expect(store.reads).toStrictEqual(PINNED_KEYS)
  })

  it('clears each accessor through the same literal key', () => {
    const store = createStore()
    const host = new PersistedHost(store.manager)
    host.writeAll('x')

    host.writeAll('')

    expect(store.unsets).toStrictEqual(PINNED_KEYS)
    expect(store.values.keys().toArray()).toStrictEqual([])
  })

  // The derivation itself, pinned as an input rather than as the
  // spelling of a property.
  it('derives the key by stringifying the accessor name', () => {
    const store = createStore()
    const host = new PersistedHost(store.manager)

    host[symbolName] = 'value'

    expect(store.writes).toStrictEqual([['Symbol(token)', 'value']])
  })
})

describe('setting storage delegation', () => {
  it('prefers the manager value over the in-memory default', () => {
    const store = createStore()
    store.values.set('username', 'stored')
    const host = new PersistedHost(store.manager)

    expect(host.username).toBe('stored')
  })

  it('falls back to the underlying accessor when the key is absent', () => {
    const store = createStore()
    const host = new PersistedHost(store.manager)

    expect(host.username).toBe('')
  })

  it('falls back to the underlying accessor when get answers undefined', () => {
    const manager: SettingManager = {
      get: vi.fn<SettingManager['get']>(),
      set: vi.fn<SettingManager['set']>(),
    }
    const host = new PersistedHost(manager)

    expect(host.username).toBe('')
    expect(manager.get).toHaveBeenCalledWith('username')
  })

  it('keeps values in memory when no manager is configured', () => {
    const host = new PersistedHost()

    host.writeAll('memory')

    expect(host.readAll()).toStrictEqual([
      'memory',
      'memory',
      'memory',
      'memory',
    ])
  })

  it('clears in memory when no manager is configured', () => {
    const host = new PersistedHost()
    host.writeAll('memory')

    host.writeAll('')

    expect(host.readAll()).toStrictEqual(['', '', '', ''])
  })

  it('stores an empty string when the host delegates no unset', () => {
    const store = createStore({ hasUnset: false })
    const host = new PersistedHost(store.manager)

    host.password = ''

    expect(store.writes).toStrictEqual([['password', '']])
    expect(store.values.get('password')).toBe('')
    // Reads back identically to the unset case: `''` either way.
    expect(host.password).toBe('')
  })

  it('routes each instance through its own manager', () => {
    const first = createStore()
    const second = createStore()
    const hostA = new PersistedHost(first.manager)
    const hostB = new PersistedHost(second.manager)

    hostA.username = 'a'
    hostB.username = 'b'

    expect(first.values.get('username')).toBe('a')
    expect(second.values.get('username')).toBe('b')
  })

  it('follows a manager attached after construction', () => {
    const store = createStore()
    const host = new PersistedHost()

    host.username = 'before'
    host.settingManager = store.manager
    host.username = 'after'

    expect(store.writes).toStrictEqual([['username', 'after']])
    expect(host.username).toBe('after')
  })
})
