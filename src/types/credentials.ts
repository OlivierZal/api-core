/**
 * The username/password pair a session mechanism signs in with. Every
 * consuming SDK's login takes exactly this shape; a protocol that also
 * posts it verbatim as its login body (Gizwits does) keeps that fact —
 * and any extra wire field — in its own types.
 * @category Types
 */
export interface LoginCredentials {
  readonly password: string
  readonly username: string
}
