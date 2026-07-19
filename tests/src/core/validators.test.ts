import { describe, it, expect } from 'vitest'
import { isEmailAttachment, isEmailMessage, isEmailChain } from '@src/core'
import type { EmailAttachment, EmailMessage, EmailChain } from '@src/core'

// validators.ts holds the structural type guards used at the boundary of the
// parsed EmailChain/EmailMessage/EmailAttachment shapes. Each guard must be
// total: true on a valid shape, false on every other input — null,
// undefined, primitives, and partial/malformed objects — never throwing.

const validAttachment: EmailAttachment = {
	name: 'file.txt',
	mimeType: 'text/plain',
	size: 4,
	bytes: new Uint8Array([1, 2, 3, 4]),
}

const validMessage: EmailMessage = {
	from: 'alice@example.com',
	to: ['bob@example.com'],
	cc: [],
	subject: 'Hello',
	date: undefined,
	text: 'body',
	html: '',
	attachments: [validAttachment],
}

const validChain: EmailChain = {
	format: 'eml',
	messages: [validMessage],
}

describe('isEmailAttachment', () => {
	it('accepts a valid EmailAttachment', () => {
		expect(isEmailAttachment(validAttachment)).toBe(true)
	})

	it('rejects null/undefined/primitives', () => {
		expect(isEmailAttachment(null)).toBe(false)
		expect(isEmailAttachment(undefined)).toBe(false)
		expect(isEmailAttachment('text')).toBe(false)
		expect(isEmailAttachment(42)).toBe(false)
		expect(isEmailAttachment(true)).toBe(false)
	})

	it('rejects a partial object missing required fields', () => {
		expect(isEmailAttachment({ name: 'file.txt', mimeType: 'text/plain' })).toBe(false)
	})

	it('rejects a wrong-typed bytes field', () => {
		expect(isEmailAttachment({ ...validAttachment, bytes: [1, 2, 3, 4] })).toBe(false)
	})
})

describe('isEmailMessage', () => {
	it('accepts a valid EmailMessage', () => {
		expect(isEmailMessage(validMessage)).toBe(true)
	})

	it('accepts a valid EmailMessage with a defined date', () => {
		expect(isEmailMessage({ ...validMessage, date: new Date() })).toBe(true)
	})

	it('rejects null/undefined/primitives', () => {
		expect(isEmailMessage(null)).toBe(false)
		expect(isEmailMessage(undefined)).toBe(false)
		expect(isEmailMessage('text')).toBe(false)
		expect(isEmailMessage(42)).toBe(false)
	})

	it('rejects a partial object missing required fields', () => {
		expect(isEmailMessage({ from: 'alice@example.com' })).toBe(false)
	})

	it('rejects a message whose attachments array contains an invalid entry', () => {
		expect(isEmailMessage({ ...validMessage, attachments: [{ name: 'bad' }] })).toBe(false)
	})

	it('rejects a wrong-typed date field', () => {
		expect(isEmailMessage({ ...validMessage, date: 'not a date' })).toBe(false)
	})
})

describe('isEmailChain', () => {
	it('accepts a valid EmailChain', () => {
		expect(isEmailChain(validChain)).toBe(true)
	})

	it('accepts a valid msg-format EmailChain', () => {
		expect(isEmailChain({ ...validChain, format: 'msg' })).toBe(true)
	})

	it('rejects null/undefined/primitives', () => {
		expect(isEmailChain(null)).toBe(false)
		expect(isEmailChain(undefined)).toBe(false)
		expect(isEmailChain('text')).toBe(false)
		expect(isEmailChain(42)).toBe(false)
	})

	it('rejects an invalid format value', () => {
		expect(isEmailChain({ ...validChain, format: 'pdf' })).toBe(false)
	})

	it('rejects a partial object missing messages', () => {
		expect(isEmailChain({ format: 'eml' })).toBe(false)
	})

	it('rejects a chain whose messages array contains an invalid entry', () => {
		expect(isEmailChain({ ...validChain, messages: [{ from: 'bad' }] })).toBe(false)
	})
})
