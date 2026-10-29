import type { MSGErrorCode } from './types.js'
import { holds, INTRINSICS, isFunction, isObject } from '@orkestrel/contract'

// An MSG/EML parsing or burning failure `throw`s an `MSGError`
// carrying a machine-readable `code`, so a `catch` branches on `error.code`
// instead of parsing the message. `createMSG` instead surfaces the same
// `MSGError` through a `Result<MSGInterface, MSGError>` so a malformed
// file never throws across that boundary.

/**
 * Represents an error thrown or returned by the MSG/EML parsing and burning surfaces, carrying a
 * machine-readable {@link MSGErrorCode} and optional structured `context`.
 *
 * @remarks
 * Carries a machine-readable {@link MSGErrorCode} so a `catch` (or a
 * `Failure.error` branch) can dispatch on `error.code` instead of parsing
 * the message text. `context` carries whatever structured detail the
 * throwing site has on hand, for example `{ offset, expected }`.
 *
 * @example
 * ```ts
 * import { MSGError } from '@src/core'
 *
 * throw new MSGError('RANGE', 'Attachment index 3 out of range', { index: 3 })
 * ```
 */
export class MSGError extends Error {
	readonly code: MSGErrorCode
	readonly context?: Readonly<Record<string, unknown>>

	constructor(code: MSGErrorCode, message: string, context?: Readonly<Record<string, unknown>>) {
		super(message)
		Object.defineProperty(this, Symbol.for('@orkestrel/msg.MSGError'), { value: this })
		this.name = 'MSGError'
		this.code = code
		if (context !== undefined) this.context = context
	}
}

/**
 * Narrows an unknown caught (or `Failure.error`) value to an {@link MSGError}.
 *
 * @remarks
 * Accepts branded errors from another installed copy and subclasses without testing `name`.
 * Requires a global Error instance, its own self brand, a declared code, and valid context.
 * Refuses transparent proxies and unbranded look-alikes.
 *
 * @param value - The value to test (typically a `catch` binding or a `Result.error`)
 * @returns True if `value` is an {@link MSGError}; false otherwise
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
	return holds(() => {
		if (!(value instanceof Error) || INTRINSICS.prototype(value) === Error.prototype) return false
		const brand = INTRINSICS.describe(value, Symbol.for('@orkestrel/msg.MSGError'))
		if (brand?.value !== value) return false
		const code = INTRINSICS.reflect.read(value, 'code')
		const context = INTRINSICS.reflect.read(value, 'context')
		return (
			(code === 'UNSUPPORTED' ||
				code === 'MALFORMED' ||
				code === 'CYCLE' ||
				code === 'RANGE' ||
				code === 'BURN') &&
			(context === undefined || isObject(context) || isFunction(context)) &&
			typeof INTRINSICS.reflect.read(value, 'message') === 'string'
		)
	})
}
