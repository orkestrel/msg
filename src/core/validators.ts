import type { EmailAttachment, EmailChain, EmailMessage } from './types.js'

/**
 * Type guard for {@link EmailAttachment}.
 *
 * @param value - Value to test
 * @returns `true` when `value` structurally matches {@link EmailAttachment}
 */
export function isEmailAttachment(value: unknown): value is EmailAttachment {
	if (typeof value !== 'object' || value === null) return false
	const candidate = value as Record<string, unknown>
	return (
		typeof candidate.name === 'string' &&
		typeof candidate.mimeType === 'string' &&
		typeof candidate.size === 'number' &&
		candidate.bytes instanceof Uint8Array
	)
}

/**
 * Type guard for {@link EmailMessage}.
 *
 * @param value - Value to test
 * @returns `true` when `value` structurally matches {@link EmailMessage}
 */
export function isEmailMessage(value: unknown): value is EmailMessage {
	if (typeof value !== 'object' || value === null) return false
	const candidate = value as Record<string, unknown>
	if (typeof candidate.from !== 'string') return false
	if (!Array.isArray(candidate.to) || !candidate.to.every((item) => typeof item === 'string'))
		return false
	if (!Array.isArray(candidate.cc) || !candidate.cc.every((item) => typeof item === 'string'))
		return false
	if (typeof candidate.subject !== 'string') return false
	if (candidate.date !== undefined && !(candidate.date instanceof Date)) return false
	if (typeof candidate.text !== 'string') return false
	if (typeof candidate.html !== 'string') return false
	if (
		!Array.isArray(candidate.attachments) ||
		!candidate.attachments.every((item) => isEmailAttachment(item))
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
	if (typeof value !== 'object' || value === null) return false
	const candidate = value as Record<string, unknown>
	if (candidate.format !== 'eml' && candidate.format !== 'msg') return false
	if (
		!Array.isArray(candidate.messages) ||
		!candidate.messages.every((item) => isEmailMessage(item))
	)
		return false
	return true
}
