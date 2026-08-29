import { describe, expectTypeOf, it } from 'vitest'

import type {
  LoginCredentials,
  UndefinedTolerant,
} from '../../src/types/index.ts'

describe('loginCredentials', () => {
  it('is the readonly username/password pair and nothing else', () => {
    expectTypeOf<LoginCredentials>().toEqualTypeOf<{
      readonly password: string
      readonly username: string
    }>()
  })

  // How both SDKs consume it: a config interface extends the tolerant
  // widening of the pair, so a host may omit either half.
  it('widens into an optional pair a config interface can extend', () => {
    expectTypeOf<UndefinedTolerant<LoginCredentials>>().toEqualTypeOf<{
      readonly password?: string | undefined
      readonly username?: string | undefined
    }>()
  })
})
