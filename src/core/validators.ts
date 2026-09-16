import type { EmailAttachment, EmailChain, EmailFormat, EmailMessage } from './types.js'
import { arrayOf, isDate, isRecord, isString, isUint8Array } from '@orkestrel/contract'

/**
 * Narrows an unknown value to a valid {@link EmailFormat}: a total from-unknown guard, true for
 * `'eml'` and `'msg'`.
 *
 * @param value - Value to check
 * @returns True if value is 'eml' or 'msg'; false otherwise
 */
export function isEmailFormat(value: unknown): value is EmailFormat {
	return value === 'eml' || value === 'msg'
}

/**
 * Narrows an unknown value to an {@link EmailAttachment}: a total from-unknown guard over
 * `name`, `mimeType`, and `bytes`.
 *
 * @param value - Value to test
 * @returns True if `value` structurally matches {@link EmailAttachment}; false otherwise
 */
export function isEmailAttachment(value: unknown): value is EmailAttachment {
	if (!isRecord(value)) return false
	return isString(value.name) && isString(value.mimeType) && isUint8Array(value.bytes)
}

/**
 * Narrows an unknown value to an {@link EmailMessage}: a total from-unknown guard over every
 * member, validating `attachments` recursively through {@link isEmailAttachment}.
 *
 * @param value - Value to test
 * @returns True if `value` structurally matches {@link EmailMessage}; false otherwise
 */
export function isEmailMessage(value: unknown): value is EmailMessage {
	if (!isRecord(value)) return false
	if (!isString(value.from)) return false
	if (!arrayOf(isString)(value.to)) return false
	if (!arrayOf(isString)(value.cc)) return false
	if (!isString(value.subject)) return false
	if (value.date !== undefined && !isDate(value.date)) return false
	if (!isString(value.text)) return false
	if (!isString(value.html)) return false
	if (!arrayOf(isEmailAttachment)(value.attachments)) return false
	return true
}

/**
 * Narrows an unknown value to an {@link EmailChain}: a total from-unknown guard over `format`
 * and `messages`, validating `messages` recursively through {@link isEmailMessage}.
 *
 * @param value - Value to test
 * @returns True if `value` structurally matches {@link EmailChain}; false otherwise
 */
export function isEmailChain(value: unknown): value is EmailChain {
	if (!isRecord(value)) return false
	if (value.format !== 'eml' && value.format !== 'msg') return false
	if (!arrayOf(isEmailMessage)(value.messages)) return false
	return true
}
