import type { EmailAttachment, EmailChain, EmailFormat, EmailMessage } from './types.js'

/**
 * Narrows an unknown value to a plain record.
 *
 * @param value - Value to check
 * @returns True if value is a non-null, non-array object; false otherwise
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Narrows an unknown value to a valid EmailFormat.
 *
 * @param value - Value to check
 * @returns True if value is 'eml' or 'msg'; false otherwise
 */
export function isEmailFormat(value: unknown): value is EmailFormat {
	return value === 'eml' || value === 'msg'
}

/**
 * Narrows an unknown value to {@link EmailAttachment}.
 *
 * @param value - Value to test
 * @returns True if `value` structurally matches {@link EmailAttachment}; false otherwise
 */
export function isEmailAttachment(value: unknown): value is EmailAttachment {
	if (!isRecord(value)) return false
	return (
		typeof value.name === 'string' &&
		typeof value.mimeType === 'string' &&
		typeof value.size === 'number' &&
		value.bytes instanceof Uint8Array
	)
}

/**
 * Narrows an unknown value to {@link EmailMessage}.
 *
 * @param value - Value to test
 * @returns True if `value` structurally matches {@link EmailMessage}; false otherwise
 */
export function isEmailMessage(value: unknown): value is EmailMessage {
	if (!isRecord(value)) return false
	if (typeof value.from !== 'string') return false
	if (!Array.isArray(value.to) || !value.to.every((item) => typeof item === 'string')) return false
	if (!Array.isArray(value.cc) || !value.cc.every((item) => typeof item === 'string')) return false
	if (typeof value.subject !== 'string') return false
	if (value.date !== undefined && !(value.date instanceof Date)) return false
	if (typeof value.text !== 'string') return false
	if (typeof value.html !== 'string') return false
	if (
		!Array.isArray(value.attachments) ||
		!value.attachments.every((item) => isEmailAttachment(item))
	) {
		return false
	}
	return true
}

/**
 * Narrows an unknown value to {@link EmailChain}.
 *
 * @param value - Value to test
 * @returns True if `value` structurally matches {@link EmailChain}; false otherwise
 */
export function isEmailChain(value: unknown): value is EmailChain {
	if (!isRecord(value)) return false
	if (value.format !== 'eml' && value.format !== 'msg') return false
	if (!Array.isArray(value.messages) || !value.messages.every((item) => isEmailMessage(item)))
		return false
	return true
}
