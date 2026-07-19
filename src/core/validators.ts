import type { EmailAttachment, EmailChain, EmailMessage } from './types.js'
import { isRecord } from './helpers.js'

/**
 * Type guard for {@link EmailAttachment}.
 *
 * @param value - Value to test
 * @returns `true` when `value` structurally matches {@link EmailAttachment}
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
 * Type guard for {@link EmailMessage}.
 *
 * @param value - Value to test
 * @returns `true` when `value` structurally matches {@link EmailMessage}
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
 * Type guard for {@link EmailChain}.
 *
 * @param value - Value to test
 * @returns `true` when `value` structurally matches {@link EmailChain}
 */
export function isEmailChain(value: unknown): value is EmailChain {
	if (!isRecord(value)) return false
	if (value.format !== 'eml' && value.format !== 'msg') return false
	if (!Array.isArray(value.messages) || !value.messages.every((item) => isEmailMessage(item)))
		return false
	return true
}
