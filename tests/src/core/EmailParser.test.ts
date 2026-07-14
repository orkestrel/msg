import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEmailParser, detectFormat, isMSGError, isSuccess, isFailure } from '@src/core'
import { asciiBytes, buildEml, buildNestedMultipart, expectDefined } from '../../setup.js'

// The EmailParser — parses raw .eml (RFC 2822/MIME) and .msg (CFB/OLE2) bytes
// into a structured EmailChain via a single synchronous `parse`. Format is
// detected from the file name extension, an explicit MIME type, or (when
// neither resolves it) a CFB magic-header sniff; every failure — an
// unrecognized format or a malformed/truncated file — surfaces as a
// `Result` Failure wrapping a typed MSGError rather than throwing across
// the parse() boundary (AGENTS §12). Driven with pure-ES fixtures (buildEml,
// buildNestedMultipart) and the four binary .msg fixtures — no mocks.

// === Fixtures

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

function readFixture(name: string): Uint8Array {
	return readFileSync(join(fixturesDir, name))
}

const MSG_FIXTURES = ['test.msg', 'attachmentFiles.msg', 'msgInMsg.msg', 'unicode1.msg'] as const

// === Detection matrix

describe('EmailParser — format detection', () => {
	it('parses a .msg fixture named "x.msg" as msg', () => {
		const parser = createEmailParser()
		const result = parser.parse({ bytes: readFixture('test.msg'), name: 'x.msg' })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		expect(result.value.format).toBe('msg')
	})

	it('parses the same .msg bytes with no name and no mime via the CFB magic sniff', () => {
		const parser = createEmailParser()
		const result = parser.parse({ bytes: readFixture('test.msg') })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		expect(result.value.format).toBe('msg')
	})

	it('parses an eml built via buildEml with name "x.eml" as eml', () => {
		const parser = createEmailParser()
		const bytes = buildEml(
			[
				['From', 'a@b.com'],
				['Content-Type', 'text/plain; charset=utf-8'],
			],
			'Hello',
		)
		const result = parser.parse({ bytes, name: 'x.eml' })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		expect(result.value.format).toBe('eml')
	})

	it('returns a Failure with code UNSUPPORTED for an unknown name and non-CFB bytes', () => {
		const parser = createEmailParser()
		const bytes = asciiBytes('plain content, not a recognized format')
		const result = parser.parse({ bytes, name: 'x.xyz' })

		expect(isFailure(result)).toBe(true)
		if (!isFailure(result)) return
		expect(isMSGError(result.error)).toBe(true)
		expect(result.error.code).toBe('UNSUPPORTED')
	})

	it('detects eml via a message/rfc822 mime with no name', () => {
		const parser = createEmailParser()
		const bytes = buildEml(
			[
				['From', 'a@b.com'],
				['Content-Type', 'text/plain; charset=utf-8'],
			],
			'Hello',
		)
		const result = parser.parse({ bytes, mime: 'message/rfc822' })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		expect(result.value.format).toBe('eml')
	})

	it('detects msg via an application/vnd.ms-outlook mime with no name', () => {
		const parser = createEmailParser()
		const result = parser.parse({
			bytes: readFixture('test.msg'),
			mime: 'application/vnd.ms-outlook',
		})

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		expect(result.value.format).toBe('msg')
	})

	it('detectFormat itself resolves by extension and mime, and returns undefined otherwise', () => {
		expect(detectFormat('message.eml', undefined)).toBe('eml')
		expect(detectFormat('message.msg', undefined)).toBe('msg')
		expect(detectFormat(undefined, 'message/rfc822')).toBe('eml')
		expect(detectFormat(undefined, 'application/vnd.ms-outlook')).toBe('msg')
		expect(detectFormat('file.txt', undefined)).toBeUndefined()
		expect(detectFormat(undefined, undefined)).toBeUndefined()
	})
})

// === .eml content

describe('EmailParser — .eml content extraction', () => {
	it('parses a single-part plain-text message into subject/from/to/text', () => {
		const parser = createEmailParser()
		const bytes = buildEml(
			[
				['From', 'Alice <alice@example.com>'],
				['To', 'Bob <bob@example.com>'],
				['Subject', 'Hello'],
				['Content-Type', 'text/plain; charset=utf-8'],
			],
			'Hello, world!',
		)
		const result = parser.parse({ bytes, name: 'plain.eml' })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		const message = expectDefined(result.value.messages[0])
		expect(message.from).toBe('Alice <alice@example.com>')
		expect(message.to).toEqual(['Bob <bob@example.com>'])
		expect(message.subject).toBe('Hello')
		expect(message.text).toContain('Hello, world!')
	})

	it('parses a multipart/alternative message into both text and html', () => {
		const parser = createEmailParser()
		const altBody = [
			'--alt',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'Plain text version',
			'--alt',
			'Content-Type: text/html; charset=utf-8',
			'',
			'<p>HTML version</p>',
			'--alt--',
		].join('\r\n')
		const bytes = buildEml(
			[
				['From', 'sender@example.com'],
				['To', 'recipient@example.com'],
				['Subject', 'Alt test'],
				['Content-Type', 'multipart/alternative; boundary="alt"'],
			],
			altBody,
		)
		const result = parser.parse({ bytes, name: 'alt.eml' })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		const message = expectDefined(result.value.messages[0])
		expect(message.text).toContain('Plain text version')
		expect(message.html).toContain('<p>HTML version</p>')
	})

	it('parses a multipart/mixed message with a base64 attachment', () => {
		const parser = createEmailParser()
		const attachmentContent = 'fake-pdf-bytes'
		const attachmentBase64 = Buffer.from(attachmentContent).toString('base64')
		const mixedBody = [
			'--mixed',
			'Content-Type: text/plain; charset=utf-8',
			'',
			'See attached.',
			'--mixed',
			'Content-Type: application/pdf; name="report.pdf"',
			'Content-Disposition: attachment; filename="report.pdf"',
			'Content-Transfer-Encoding: base64',
			'',
			attachmentBase64,
			'--mixed--',
		].join('\r\n')
		const bytes = buildEml(
			[
				['From', 'a@b.com'],
				['To', 'c@d.com'],
				['Subject', 'Mixed test'],
				['Content-Type', 'multipart/mixed; boundary="mixed"'],
			],
			mixedBody,
		)
		const result = parser.parse({ bytes, name: 'mixed.eml' })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		const message = expectDefined(result.value.messages[0])
		expect(message.attachments).toHaveLength(1)
		const attachment = expectDefined(message.attachments[0])
		expect(attachment.name).toBe('report.pdf')
		expect(Buffer.from(attachment.bytes).toString()).toBe(attachmentContent)
	})

	it('decodes a quoted-printable body (=C3=A9 → e-acute) under utf-8 charset', () => {
		const parser = createEmailParser()
		const bytes = buildEml(
			[
				['From', 'a@b.com'],
				['Content-Type', 'text/plain; charset=utf-8'],
				['Content-Transfer-Encoding', 'quoted-printable'],
			],
			'caf=C3=A9',
		)
		const result = parser.parse({ bytes, name: 'qp.eml' })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		const message = expectDefined(result.value.messages[0])
		expect(message.text).toContain('café')
	})

	it('decodes an RFC 2047 base64 (B) encoded-word subject', () => {
		const parser = createEmailParser()
		const bytes = buildEml(
			[
				['From', 'a@b.com'],
				['Subject', '=?UTF-8?B?SGVsbG8=?='],
				['Content-Type', 'text/plain; charset=utf-8'],
			],
			'Body',
		)
		const result = parser.parse({ bytes, name: 'subject-b.eml' })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		expect(expectDefined(result.value.messages[0]).subject).toBe('Hello')
	})

	it('decodes an RFC 2047 quoted-printable (Q) encoded-word subject', () => {
		const parser = createEmailParser()
		const bytes = buildEml(
			[
				['From', 'a@b.com'],
				['Subject', '=?UTF-8?Q?Hello_World?='],
				['Content-Type', 'text/plain; charset=utf-8'],
			],
			'Body',
		)
		const result = parser.parse({ bytes, name: 'subject-q.eml' })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		expect(expectDefined(result.value.messages[0]).subject).toBe('Hello World')
	})
})

// === .msg fixtures

describe('EmailParser — .msg fixtures', () => {
	it.each(MSG_FIXTURES)('parses %s to Success exposing subject/body/attachments', (name) => {
		const parser = createEmailParser()
		const result = parser.parse({ bytes: readFixture(name), name })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		expect(result.value.format).toBe('msg')
		const message = expectDefined(result.value.messages[0])
		expect(typeof message.subject).toBe('string')
		expect(typeof message.text).toBe('string')
		expect(Array.isArray(message.attachments)).toBe(true)
	})

	it('exposes decoded attachments from attachmentFiles.msg', () => {
		const parser = createEmailParser()
		const result = parser.parse({
			bytes: readFixture('attachmentFiles.msg'),
			name: 'attachmentFiles.msg',
		})

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		const message = expectDefined(result.value.messages[0])
		expect(message.attachments.length).toBeGreaterThan(0)
		for (const attachment of message.attachments) {
			expect(attachment.name.length).toBeGreaterThan(0)
			expect(attachment.bytes).toBeInstanceOf(Uint8Array)
		}
	})

	it('parses msgInMsg.msg (exercises the embedded message path) without throwing', () => {
		const parser = createEmailParser()
		const result = parser.parse({ bytes: readFixture('msgInMsg.msg'), name: 'msgInMsg.msg' })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) return
		expect(result.value.format).toBe('msg')
	})

	it('returns a Failure with a structural MSGError code (never throws) for a truncated .msg', () => {
		const parser = createEmailParser()
		const truncated = readFixture('test.msg').slice(0, 700)

		let thrown = false
		let result
		try {
			result = parser.parse({ bytes: truncated, name: 'x.msg' })
		} catch {
			thrown = true
		}

		expect(thrown).toBe(false)
		expect(isFailure(expectDefined(result))).toBe(true)
		if (result === undefined || isSuccess(result)) return
		expect(isMSGError(result.error)).toBe(true)
		expect(result.error.code).not.toBe('UNSUPPORTED')
	})
})

// === Deep nesting

describe('EmailParser — MIME nesting depth guard', () => {
	it('returns a Failure with code CYCLE for MIME nested past the max depth', () => {
		const parser = createEmailParser()
		const bytes = buildNestedMultipart(60)
		const result = parser.parse({ bytes, name: 'deep.eml' })

		expect(isFailure(result)).toBe(true)
		if (!isFailure(result)) return
		expect(isMSGError(result.error)).toBe(true)
		expect(result.error.code).toBe('CYCLE')
	})

	it('parses a shallow (depth 3) nested multipart to Success', () => {
		const parser = createEmailParser()
		const bytes = buildNestedMultipart(3)
		const result = parser.parse({ bytes, name: 'shallow.eml' })

		expect(isSuccess(result)).toBe(true)
	})
})

// === Options

describe('EmailParser — options', () => {
	it('returns the default options shape from a parser created with no options', () => {
		const parser = createEmailParser()
		expect(parser.options).toEqual({})
	})

	it('exposes a constructor { encoding: "latin1" } option via .options, and still parses an eml', () => {
		const parser = createEmailParser({ encoding: 'latin1' })
		expect(parser.options).toEqual({ encoding: 'latin1' })

		const bytes = buildEml(
			[
				['From', 'a@b.com'],
				['Content-Type', 'text/plain; charset=utf-8'],
			],
			'Hello',
		)
		const result = parser.parse({ bytes, name: 'x.eml' })
		expect(isSuccess(result)).toBe(true)
	})

	it('never leaks the internal options reference — each read is an independent copy', () => {
		const parser = createEmailParser({ encoding: 'latin1' })
		const first = parser.options
		const second = parser.options
		expect(first).not.toBe(second)
		expect(first).toEqual(second)
	})
})
