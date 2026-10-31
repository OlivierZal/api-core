import { describe, expect, it } from 'vitest'

import { causeChain } from '../../src/errors/cause-chain.ts'

describe(causeChain, () => {
  it('yields the value itself, then each cause, outermost first', () => {
    const root = new Error('root')
    const middle = new Error('middle', { cause: root })
    const outer = new Error('outer', { cause: middle })

    expect(causeChain(outer).toArray()).toStrictEqual([outer, middle, root])
  })

  // Plain objects, since a built-in error's `cause` is not reassigned:
  // the walk reads `cause` off any object link alike.
  it('walks a cycle once', () => {
    const first: { cause?: object } = {}
    const second = { cause: first }
    first.cause = second

    expect(causeChain(first).toArray()).toStrictEqual([first, second])
  })

  // A plain object is a link like any other — the predicates decide what
  // they recognise in it, the walk only hands it over.
  it('yields a plain-object link', () => {
    const cause = { code: 'ECONNRESET' }
    const error = new Error('wrapped', { cause })

    expect(causeChain(error).toArray()).toStrictEqual([error, cause])
  })

  it.each([
    ['a primitive', 'offline'],
    ['null', null],
  ])('ends the walk at %s, since nothing hangs off it', (_name, cause) => {
    const error = new Error('wrapped', { cause })

    expect(causeChain(error).toArray()).toStrictEqual([error])
  })

  it('yields nothing for a thrown primitive', () => {
    expect(causeChain('offline').toArray()).toStrictEqual([])
  })
})
