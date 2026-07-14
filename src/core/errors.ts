import type { MSGErrorCode } from './types.js'

// AGENTS §12: an MSG/EML parsing or burning failure `throw`s an `MSGError`
// carrying a machine-readable `code`, so a `catch` branches on `error.code`
// instead of parsing the message. `EmailParserInterface.parse` instead
// surfaces the same `MSGError` through a `Result<EmailChain, MSGError>`
// so a malformed file never throws across that boundary.

/**
 * An error thrown or returned by the MSG/EML parsing and burning surfaces.
 *
 * @remarks
 * Carries a machine-readable {@link MSGErrorCode} so a `catch` (or a
 * `Failure.error` branch) can dispatch on `error.code` instead of parsing
 * the message text. `context` carries whatever structured detail the
 * throwing site has on hand (e.g. `{ offset, expected }`).
 */
export class MSGError extends Error {
	readonly code: MSGErrorCode
	readonly context?: Readonly<Record<string, unknown>>

	constructor(code: MSGErrorCode, message: string, context?: Readonly<Record<string, unknown>>) {
		super(message)
		this.name = 'MSGError'
		this.code = code
		this.context = context
	}
}

/**
 * Narrow an unknown caught (or `Failure.error`) value to an {@link MSGError}.
 *
 * @param value - The value to test (typically a `catch` binding or a `Result.error`)
 * @returns `true` when `value` is an {@link MSGError}
 *
 * @example
 * ```ts
 * import { isMSGError } from '@src/core'
 *
 * try {
 * 	reader.parse()
 * } catch (error) {
 * 	if (isMSGError(error) && error.code === 'MALFORMED') return
 * }
 * ```
 */
export function isMSGError(value: unknown): value is MSGError {
	return value instanceof MSGError
}
