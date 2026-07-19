import type { MSGInput, MSGOptions, MSGInterface, Result } from './types.js'
import type { MSGError } from './errors.js'
import { MSG } from './MSG.js'
import { success, failure } from './helpers.js'
import { isMSGError } from './errors.js'

// === MSG

/**
 * Create a new {@link MSGInterface} for the given .eml or .msg input.
 *
 * @remarks
 * This is a total boundary: unlike `new MSG(...)`, which parses eagerly
 * and throws a typed {@link MSGError} on malformed or unsupported input,
 * `createMSG` never throws — every failure surfaces as a `Failure` in the
 * returned {@link Result}. This is a deliberate NEW dual API, not a mirror
 * of `new MSG()`: reach for `new MSG()` when a thrown exception is the
 * desired control flow, and `createMSG` when a `Result` is preferred.
 *
 * @param input - Raw .eml/.msg bytes or buffer
 * @param options - Optional parser configuration
 * @returns A `Result` carrying a working {@link MSGInterface} on success,
 * or the {@link MSGError} on failure
 *
 * @example
 * ```ts
 * import { createMSG, isSuccess } from '@src/core'
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
