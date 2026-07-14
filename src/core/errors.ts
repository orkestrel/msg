import type { MsgErrorCode } from './types.js'

// AGENTS §12: an MSG/EML parsing or burning failure `throw`s an `MsgError`
// carrying a machine-readable `code`, so a `catch` branches on `error.code`
// instead of parsing the message. `EmailParserInterface.parse` instead
// surfaces the same `MsgError` through a `Result<EmailChain, MsgError>`
// so a malformed file never throws across that boundary.

/**
 * An error thrown or returned by the MSG/EML parsing and burning surfaces.
 *
 * @remarks
 * Carries a machine-readable {@link MsgErrorCode} so a `catch` (or a
 * `Failure.error` branch) can dispatch on `error.code` instead of parsing
 * the message text. `context` carries whatever structured detail the
 * throwing site has on hand (e.g. `{ offset, expected }`).
 */
export class MsgError extends Error {
	readonly code: MsgErrorCode
	readonly context?: Readonly<Record<string, unknown>>

	constructor(code: MsgErrorCode, message: string, context?: Readonly<Record<string, unknown>>) {
		super(message)
		this.name = 'MsgError'
		this.code = code
		this.context = context
	}
}

/**
 * Narrow an unknown caught (or `Failure.error`) value to an {@link MsgError}.
 *
 * @param value - The value to test (typically a `catch` binding or a `Result.error`)
 * @returns `true` when `value` is an {@link MsgError}
 *
 * @example
 * ```ts
 * import { isMsgError } from '@src/core'
 *
 * try {
 * 	reader.parse()
 * } catch (error) {
 * 	if (isMsgError(error) && error.code === 'MALFORMED') return
 * }
 * ```
 */
export function isMsgError(value: unknown): value is MsgError {
	return value instanceof MsgError
}
