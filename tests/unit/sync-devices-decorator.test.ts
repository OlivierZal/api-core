import { describe, expect, it, vi } from 'vitest'

import { syncDevices } from '../../src/decorators/index.ts'
import { mock } from '../../src/testing/index.ts'

// The host contract the decorated method is bound to: the SDKs' API
// classes (`SessionAPI.notifySync`) and facades alike.
interface Host {
  readonly notifySync?: ((params?: SyncParams) => Promise<void>) | undefined
}

// A consumer-defined sync payload, standing in for the SDKs' own
// (melcloud's `{ ids, type }`, heatzy's `{ ids }`).
interface SyncParams {
  readonly ids?: string[] | undefined
  readonly type?: string | undefined
}

const decorate = (
  target: () => Promise<string>,
  params?: SyncParams,
): ((this: Host) => Promise<string>) =>
  syncDevices(params)(target, mock<ClassMethodDecoratorContext>())

describe(syncDevices, () => {
  it('notifies after the decorated method resolves, forwarding the params verbatim', async () => {
    const trace: string[] = []
    const params: SyncParams = { type: 'ata' }
    const notifySync = vi.fn<(params?: SyncParams) => Promise<void>>(
      async () => {
        trace.push('notify')
        await Promise.resolve()
      },
    )
    const target = vi.fn<() => Promise<string>>(async () => {
      trace.push('target')
      await Promise.resolve()
      return 'result'
    })

    await expect(decorate(target, params).call({ notifySync })).resolves.toBe(
      'result',
    )

    expect(trace).toStrictEqual(['target', 'notify'])
    expect(notifySync).toHaveBeenCalledTimes(1)
    expect(notifySync.mock.calls[0]?.[0]).toBe(params)
  })

  it('notifies without a payload when built without one', async () => {
    const notifySync = vi.fn<(params?: SyncParams) => Promise<void>>()
    const target = vi.fn<() => Promise<string>>().mockResolvedValue('result')

    await decorate(target).call({ notifySync })

    expect(notifySync.mock.calls).toStrictEqual([[undefined]])
  })

  it('returns the result untouched when the host exposes no hook', async () => {
    const target = vi.fn<() => Promise<string>>().mockResolvedValue('result')

    await expect(decorate(target).call({})).resolves.toBe('result')
  })

  it('propagates a rejecting notification instead of swallowing it', async () => {
    const notifySync = vi
      .fn<(params?: SyncParams) => Promise<void>>()
      .mockRejectedValue(new Error('sync boom'))
    const target = vi.fn<() => Promise<string>>().mockResolvedValue('result')

    await expect(decorate(target).call({ notifySync })).rejects.toThrow(
      'sync boom',
    )
  })

  it('never notifies when the decorated method rejects', async () => {
    const notifySync = vi.fn<(params?: SyncParams) => Promise<void>>()
    const target = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error('target boom'))

    await expect(decorate(target).call({ notifySync })).rejects.toThrow(
      'target boom',
    )
    expect(notifySync).not.toHaveBeenCalled()
  })

  // Applied through the TC39 protocol the consumers' classes use — the
  // decorator is a factory, so the parentheses are part of the call
  // site even without a payload. Both forms on one typed host; the host
  // contract is structural and an application site is not held to it
  // (probed), so this clause pins the runtime protocol, not a type
  // check.
  it('applies through the method decorator protocol', async () => {
    class SyncingHost {
      public readonly notifySync =
        vi.fn<(params?: SyncParams) => Promise<void>>()

      public readonly saved: string[] = []

      @syncDevices({ ids: ['a'] })
      public async save(value: string): Promise<number> {
        await Promise.resolve()
        this.saved.push(value)
        return this.saved.length
      }

      @syncDevices()
      public async touch(): Promise<void> {
        await Promise.resolve()
        this.saved.push('touched')
      }
    }
    const host = new SyncingHost()

    await expect(host.save('x')).resolves.toBe(1)

    await host.touch()

    expect(host.saved).toStrictEqual(['x', 'touched'])
    expect(host.notifySync.mock.calls).toStrictEqual([
      [{ ids: ['a'] }],
      [undefined],
    ])
  })
})
