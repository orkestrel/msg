import type { MSGInput, MSGOptions, MSGInterface, Result } from './types.js'
import type { MSGError } from './errors.js'
import { MSG } from './MSG.js'
import { success, failure } from './helpers.js'
import { isMSGError } from './errors.js'

// === MSG

/**
 * Creates an {@link MSGInterface} for raw `.eml` or `.msg` input and returns it inside a
 * {@link Result}: every parse failure surfaces as a `Failure` carrying the {@link MSGError}
 * instead of throwing, and an unexpected non-`MSGError` error still propagates.
 *
 * @remarks
 * This and `new MSG()` are two entry points, not one wrapping the other. `new MSG()` parses
 * eagerly and throws the typed {@link MSGError} on malformed or unsupported input; reach for it
 * when a thrown exception is the control flow you want.
 *
 * @param input - Raw .eml/.msg bytes or buffer
 * @param options - Optional parser configuration
 * @returns A `Result` carrying a working {@link MSGInterface} on success,
 * or the {@link MSGError} on failure
 *
 * @example Parse an email file and read its format
 * ```ts
 * import { createMSG, isSuccess } from '@orkestrel/msg'
 *
 * const result = createMSG(bytes)
 * if (isSuccess(result)) {
 * 	console.log(result.value.chain.format)
 * }
 * ```
 */
export function createMSG(input: MSGInput, options?: MSGOptions): Result<MSGInterface, MSGError> {
	try {
		return success(new MSG(input, options))
	} catch (error) {
		if (isMSGError(error)) return failure(error)
		throw error
	}
}
