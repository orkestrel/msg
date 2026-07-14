import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import {
	success,
	failure,
	isSuccess,
	isFailure,
	isRecord,
	isMsgFile,
	removeTrailingNull,
	readUtf16String,
	readAnsiString,
	fileTimeToUtcString,
	toHexLower,
	msftUuidStringify,
	roundUpToMultiple,
	sectorsNeeded,
	compareCfbName,
	decodeBase64,
	encodeUtf8,
	decodeUtf8,
	decodeLatin1,
	decodeWindows1252,
	resolveEncoding,
	isEmailFormat,
	detectFormat,
	parseMimeHeaders,
	parseMimePart,
	decodeMimeEncoding,
	decodeMimeText,
	decodeMimeWords,
	formatEmailAddress,
	extractMessage,
	inferExtension,
	isMsgError,
} from '@src/core'
import type { Result } from '@src/core'
import {
	asciiBytes,
	buildEml,
	buildNestedMultipart,
	captureError,
	expectDefined,
} from '../../setup.js'

const FIXTURES_DIR = fileURLToPath(new URL('./fixtures/', import.meta.url))

function readFixture(name: string): DataView {
	const buffer = readFileSync(`${FIXTURES_DIR}${name}`)
	return new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
}

// helpers.ts is the root-level exported utility surface for @src/core — pure
// leaves with no instance state (AGENTS §5). Each exported helper gets its
// own describe block covering happy path, edge cases, and error paths.

describe('Result helpers', () => {
	describe('success / failure', () => {
		it('success wraps a value', () => {
			expect(success(42)).toEqual({ success: true, value: 42 })
		})

		it('failure wraps an error', () => {
			const error = new Error('boom')
			expect(failure(error)).toEqual({ success: false, error })
		})
	})

	describe('isSuccess / isFailure', () => {
		it('narrows a Success result', () => {
			const result: Result<number> = success(1)
			expect(isSuccess(result)).toBe(true)
			expect(isFailure(result)).toBe(false)
			expect(isSuccess(result) && result.value).toBe(1)
		})

		it('narrows a Failure result', () => {
			const result: Result<number, string> = failure('nope')
			expect(isSuccess(result)).toBe(false)
			expect(isFailure(result)).toBe(true)
			expect(isFailure(result) && result.error).toBe('nope')
		})
	})

	describe('isRecord', () => {
		it('accepts a plain object', () => {
			expect(isRecord({})).toBe(true)
			expect(isRecord({ a: 1 })).toBe(true)
		})

		it('rejects null', () => {
			expect(isRecord(null)).toBe(false)
		})

		it('rejects an array', () => {
			expect(isRecord([1, 2, 3])).toBe(false)
			expect(isRecord([])).toBe(false)
		})

		it('rejects primitives', () => {
			expect(isRecord('text')).toBe(false)
			expect(isRecord(42)).toBe(false)
			expect(isRecord(true)).toBe(false)
			expect(isRecord(undefined)).toBe(false)
		})
	})
})

describe('decodeBase64', () => {
	it('decodes a canonical padded vector', () => {
		expect(Array.from(decodeBase64('aGVsbG8='))).toEqual([104, 101, 108, 108, 111])
	})

	it('tolerates missing padding', () => {
		expect(Array.from(decodeBase64('aGVsbG8'))).toEqual([104, 101, 108, 108, 111])
	})

	it('ignores embedded whitespace and newlines', () => {
		expect(Array.from(decodeBase64('aGVs\n bG8=\t'))).toEqual([104, 101, 108, 108, 111])
	})

	it('throws MsgError MALFORMED on an invalid character', () => {
		const thrown = captureError(() => decodeBase64('!!!!'))
		expect(isMsgError(thrown)).toBe(true)
		expect(isMsgError(thrown) && thrown.code).toBe('MALFORMED')
	})
})

describe('encodeUtf8 / decodeUtf8', () => {
	it('round-trips ASCII', () => {
		expect(decodeUtf8(encodeUtf8('Hello'))).toBe('Hello')
	})

	it('round-trips a 2-byte sequence (e-acute)', () => {
		expect(decodeUtf8(encodeUtf8('é'))).toBe('é')
		expect(Array.from(encodeUtf8('é'))).toEqual([0xc3, 0xa9])
	})

	it('round-trips a 3-byte sequence (Euro sign)', () => {
		expect(decodeUtf8(encodeUtf8('€'))).toBe('€')
		expect(Array.from(encodeUtf8('€'))).toEqual([0xe2, 0x82, 0xac])
	})

	it('round-trips a 4-byte sequence (an emoji via surrogate pair)', () => {
		expect(decodeUtf8(encodeUtf8('😀'))).toBe('😀')
		expect(Array.from(encodeUtf8('😀'))).toEqual([0xf0, 0x9f, 0x98, 0x80])
	})

	it('decodeUtf8 never throws on invalid bytes — yields U+FFFD', () => {
		expect(decodeUtf8(new Uint8Array([0xff]))).toBe('�')
	})

	it('decodeUtf8 never throws on a truncated multibyte sequence', () => {
		// 0xe2 announces a 3-byte sequence but only one continuation byte follows.
		expect(decodeUtf8(new Uint8Array([0xe2, 0x82]))).toBe('��')
	})

	it('encodeUtf8 encodes a lone (unpaired) surrogate as U+FFFD', () => {
		expect(Array.from(encodeUtf8('\ud800'))).toEqual([0xef, 0xbf, 0xbd])
	})

	it('decodeUtf8 rejects an overlong 2-byte encoding of NUL as U+FFFD', () => {
		expect(decodeUtf8(new Uint8Array([0xc0, 0x80]))).toBe('�')
	})

	it('decodeUtf8 rejects an overlong 2-byte encoding of "<" (never decodes to it)', () => {
		expect(decodeUtf8(new Uint8Array([0xc0, 0xbc]))).not.toContain('<')
		expect(decodeUtf8(new Uint8Array([0xc0, 0xbc]))).toBe('�')
	})

	it('decodeUtf8 rejects a surrogate code point as U+FFFD', () => {
		expect(decodeUtf8(new Uint8Array([0xed, 0xa0, 0x80]))).toBe('�')
	})

	it('decodeUtf8 rejects an out-of-range code point (> U+10FFFF) as U+FFFD', () => {
		expect(decodeUtf8(new Uint8Array([0xf7, 0xbf, 0xbf, 0xbf]))).toBe('�')
	})

	it('decodeUtf8 still round-trips a valid mixed ASCII/multibyte string', () => {
		const text = 'Hello café €100 😀'
		expect(decodeUtf8(encodeUtf8(text))).toBe(text)
	})
})

describe('decodeLatin1', () => {
	it('maps bytes 0x41 / 0xE9 / 0xFF to their code points', () => {
		expect(decodeLatin1(new Uint8Array([0x41]))).toBe('A')
		expect(decodeLatin1(new Uint8Array([0xe9]))).toBe('é')
		expect(decodeLatin1(new Uint8Array([0xff]))).toBe('ÿ')
	})
})

describe('decodeWindows1252', () => {
	it('maps 0x80 to the Euro sign', () => {
		expect(decodeWindows1252(new Uint8Array([0x80]))).toBe('€')
	})

	it('maps 0x9C to the oe-ligature', () => {
		expect(decodeWindows1252(new Uint8Array([0x9c]))).toBe('œ')
	})

	it('leaves plain ASCII unchanged', () => {
		expect(decodeWindows1252(new Uint8Array([0x41, 0x42]))).toBe('AB')
	})
})

describe('resolveEncoding', () => {
	it('resolves the full label matrix', () => {
		expect(resolveEncoding('utf-8')).toBe('utf-8')
		expect(resolveEncoding('UTF8')).toBe('utf-8')
		expect(resolveEncoding('utf-16')).toBe('utf-16le')
		expect(resolveEncoding('utf-16le')).toBe('utf-16le')
		expect(resolveEncoding('windows-1252')).toBe('windows-1252')
		expect(resolveEncoding('cp1252')).toBe('windows-1252')
		expect(resolveEncoding('us-ascii')).toBe('latin1')
		expect(resolveEncoding('ascii')).toBe('latin1')
		expect(resolveEncoding('iso-8859-1')).toBe('latin1')
		expect(resolveEncoding('latin1')).toBe('latin1')
	})

	it('trims and lowercases the label', () => {
		expect(resolveEncoding(' UTF-8 ')).toBe('utf-8')
	})

	it('falls back to utf-8 for an unknown label', () => {
		expect(resolveEncoding('shift-jis')).toBe('utf-8')
	})

	it('falls back to utf-8 when undefined', () => {
		expect(resolveEncoding(undefined)).toBe('utf-8')
	})
})

describe('readUtf16String', () => {
	it('reads a known UTF-16LE vector', () => {
		const bytes = new Uint8Array([0x48, 0x00, 0x69, 0x00]) // 'Hi'
		const view = new DataView(bytes.buffer)
		expect(readUtf16String(view, 0, 2)).toBe('Hi')
	})

	it('reads starting at a non-zero offset', () => {
		const bytes = new Uint8Array([0xff, 0xff, 0x41, 0x00, 0x42, 0x00])
		const view = new DataView(bytes.buffer)
		expect(readUtf16String(view, 2, 2)).toBe('AB')
	})

	it('throws MsgError MALFORMED when the requested range exceeds the view bounds', () => {
		const bytes = new Uint8Array([0x41, 0x00])
		const view = new DataView(bytes.buffer)
		const thrown = captureError(() => readUtf16String(view, 0, 1000))
		expect(isMsgError(thrown)).toBe(true)
		expect(isMsgError(thrown) && thrown.code).toBe('MALFORMED')
	})
})

describe('readAnsiString', () => {
	it('decodes utf-16le', () => {
		const bytes = new Uint8Array([0x48, 0x00, 0x69, 0x00]) // 'Hi'
		expect(readAnsiString(bytes, 'utf-16le')).toBe('Hi')
	})

	it('decodes utf-8', () => {
		expect(readAnsiString(encodeUtf8('café'), 'utf-8')).toBe('café')
	})

	it('decodes latin1', () => {
		expect(readAnsiString(new Uint8Array([0x41, 0xe9]), 'latin1')).toBe('Aé')
	})

	it('decodes windows-1252 (default when encoding is omitted)', () => {
		expect(readAnsiString(new Uint8Array([0x80]))).toBe('€')
		expect(readAnsiString(new Uint8Array([0x80]), 'windows-1252')).toBe('€')
	})
})

describe('removeTrailingNull', () => {
	it('removes a trailing null and everything after it', () => {
		expect(removeTrailingNull('hello\0world')).toBe('hello')
	})

	it('returns the string unchanged when there is no null', () => {
		expect(removeTrailingNull('hello')).toBe('hello')
	})

	it('returns an empty string when the first character is null', () => {
		expect(removeTrailingNull('\0hello')).toBe('')
	})
})

describe('toHexLower', () => {
	it('pads a small value to a fixed length', () => {
		expect(toHexLower(255, 2)).toBe('ff')
		expect(toHexLower(0, 4)).toBe('0000')
	})

	it('truncates to the low bits when the value exceeds the padded width', () => {
		expect(toHexLower(0x1ff, 2)).toBe('ff')
	})
})

describe('msftUuidStringify', () => {
	it('stringifies a mixed-endian UUID from a known byte vector', () => {
		const data = new Uint8Array([
			0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
			0x10,
		])
		expect(msftUuidStringify(data, 0)).toBe('04030201-0605-0807-090a-0b0c0d0e0f10')
	})

	it('reads starting at a non-zero offset', () => {
		const data = new Uint8Array([
			0xff, 0xff, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
			0x0e, 0x0f, 0x10,
		])
		expect(msftUuidStringify(data, 2)).toBe('04030201-0605-0807-090a-0b0c0d0e0f10')
	})
})

describe('fileTimeToUtcString', () => {
	it('converts the FILETIME epoch (116444736000000000) to the Unix epoch string', () => {
		expect(fileTimeToUtcString(3577643008, 27111902)).toBe(new Date(0).toUTCString())
	})

	it('converts a modern FILETIME vector computed with BigInt (no float drift)', () => {
		// 2024-03-15T12:34:56.000Z, derived in-test via BigInt so it can never drift
		// from the implementation's own arithmetic.
		const epoch = 116444736000000000n
		const targetMs = Date.UTC(2024, 2, 15, 12, 34, 56, 0)
		const fileTime = BigInt(targetMs) * 10000n + epoch
		const low = Number(fileTime & 0xffffffffn)
		const high = Number(fileTime >> 32n)
		expect(fileTimeToUtcString(low, high)).toBe(new Date(targetMs).toUTCString())
	})
})

describe('roundUpToMultiple', () => {
	it('returns 0 for 0', () => {
		expect(roundUpToMultiple(0, 512)).toBe(0)
	})

	it('returns the value unchanged when already an exact multiple', () => {
		expect(roundUpToMultiple(512, 512)).toBe(512)
		expect(roundUpToMultiple(1024, 512)).toBe(1024)
	})

	it('rounds a multiple+1 up to the next boundary', () => {
		expect(roundUpToMultiple(513, 512)).toBe(1024)
	})
})

describe('sectorsNeeded', () => {
	it('returns 0 for 0 bytes', () => {
		expect(sectorsNeeded(0, 512)).toBe(0)
	})

	it('returns exactly 1 for exactly one sector', () => {
		expect(sectorsNeeded(512, 512)).toBe(1)
	})

	it('returns 2 for one sector + 1 byte', () => {
		expect(sectorsNeeded(513, 512)).toBe(2)
	})
})

describe('compareCfbName', () => {
	it('orders the shorter name first', () => {
		expect(compareCfbName('a', 'ab')).toBeLessThan(0)
		expect(compareCfbName('ab', 'a')).toBeGreaterThan(0)
	})

	it('orders case-insensitively when lengths match', () => {
		expect(compareCfbName('ABC', 'abc')).toBe(0)
		expect(compareCfbName('abc', 'abd')).toBeLessThan(0)
		expect(compareCfbName('ABD', 'abc')).toBeGreaterThan(0)
	})
})

describe('isMsgFile', () => {
	it('returns true for a real CFB fixture', () => {
		expect(isMsgFile(readFixture('test.msg'))).toBe(true)
	})

	it('returns false for arbitrary ascii bytes', () => {
		const bytes = asciiBytes('not a compound file at all')
		expect(isMsgFile(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength))).toBe(false)
	})

	it('returns false for an empty buffer', () => {
		const bytes = new Uint8Array(0)
		expect(isMsgFile(new DataView(bytes.buffer))).toBe(false)
	})
})

describe('isEmailFormat', () => {
	it('accepts eml and msg', () => {
		expect(isEmailFormat('eml')).toBe(true)
		expect(isEmailFormat('msg')).toBe(true)
	})

	it('rejects any other value', () => {
		expect(isEmailFormat('pdf')).toBe(false)
		expect(isEmailFormat(undefined)).toBe(false)
		expect(isEmailFormat(null)).toBe(false)
		expect(isEmailFormat(42)).toBe(false)
	})
})

describe('detectFormat', () => {
	it('detects eml from a .eml filename', () => {
		expect(detectFormat('message.eml', undefined)).toBe('eml')
		expect(detectFormat('MESSAGE.EML', undefined)).toBe('eml')
	})

	it('detects msg from a .msg filename', () => {
		expect(detectFormat('message.msg', undefined)).toBe('msg')
	})

	it('detects eml from a message/rfc822 mime type', () => {
		expect(detectFormat(undefined, 'message/rfc822')).toBe('eml')
	})

	it('detects msg from an application/vnd.ms-outlook mime type', () => {
		expect(detectFormat(undefined, 'application/vnd.ms-outlook')).toBe('msg')
	})

	it('prefers the filename extension over the mime type', () => {
		expect(detectFormat('message.eml', 'application/vnd.ms-outlook')).toBe('eml')
	})

	it('returns undefined when neither hint resolves', () => {
		expect(detectFormat(undefined, undefined)).toBeUndefined()
		expect(detectFormat('message.txt', 'text/plain')).toBeUndefined()
	})
})

describe('inferExtension', () => {
	it('infers from a known mime type', () => {
		expect(inferExtension('image/jpeg')).toBe('.jpg')
	})

	it('infers from a filename extension', () => {
		expect(inferExtension(undefined, 'archive.zip')).toBe('.zip')
	})

	it('prefers the filename over the mime type', () => {
		expect(inferExtension('image/png', 'photo.jpeg')).toBe('.jpeg')
	})

	it('falls back to .bin when neither hint resolves', () => {
		expect(inferExtension()).toBe('.bin')
		expect(inferExtension('application/x-custom')).toBe('.bin')
		expect(inferExtension(undefined, 'no-extension-here')).toBe('.bin')
	})
})

describe('parseMimeHeaders', () => {
	it('parses multiple headers case-insensitively', () => {
		const headers = parseMimeHeaders('Subject: Hello\r\nFROM: alice@example.com\r\n')
		expect(headers.get('subject')?.value).toBe('Hello')
		expect(headers.get('from')?.value).toBe('alice@example.com')
	})

	it('joins a folded continuation line onto the previous header', () => {
		const headers = parseMimeHeaders('Subject: Hello\r\n World\r\n')
		expect(headers.get('subject')?.value).toBe('Hello World')
	})

	it('joins a tab-indented continuation line', () => {
		const headers = parseMimeHeaders('Subject: Hello\r\n\tWorld\r\n')
		expect(headers.get('subject')?.value).toBe('Hello World')
	})

	it('parses content-type parameters', () => {
		const headers = parseMimeHeaders('Content-Type: text/plain; charset="utf-8"\r\n')
		const header = expectDefined(headers.get('content-type'))
		expect(header.value).toBe('text/plain')
		expect(header.params.get('charset')).toBe('utf-8')
	})

	it('keeps only the first occurrence of a repeated header', () => {
		const headers = parseMimeHeaders('X-Test: first\r\nX-Test: second\r\n')
		expect(headers.get('x-test')?.value).toBe('first')
	})
})

describe('parseMimePart', () => {
	it('parses a small multipart message into its child parts', () => {
		const raw = decodeUtf8(
			buildEml(
				[['Content-Type', 'multipart/mixed; boundary="XYZ"']],
				'--XYZ\r\nContent-Type: text/plain\r\n\r\nHello\r\n--XYZ\r\nContent-Type: text/html\r\n\r\n<p>Hi</p>\r\n--XYZ--',
			),
		)

		const part = parseMimePart(raw)

		expect(part.parts).toHaveLength(2)
		expect(part.parts[0]?.headers.get('content-type')?.value).toBe('text/plain')
		expect(part.parts[0]?.body).toBe('Hello')
		expect(part.parts[1]?.headers.get('content-type')?.value).toBe('text/html')
		expect(part.parts[1]?.body).toBe('<p>Hi</p>')
	})

	it('parses a non-multipart message with an empty parts list', () => {
		const raw = decodeUtf8(buildEml([['Content-Type', 'text/plain']], 'just text'))
		const part = parseMimePart(raw)
		expect(part.parts).toEqual([])
		expect(part.body).toBe('just text')
	})

	it('throws MsgError CYCLE once nesting exceeds the maximum depth', () => {
		const raw = decodeUtf8(buildNestedMultipart(60))

		const thrown = captureError(() => parseMimePart(raw))

		expect(isMsgError(thrown)).toBe(true)
		expect(isMsgError(thrown) && thrown.code).toBe('CYCLE')
	})
})

describe('decodeMimeEncoding', () => {
	it('decodes a base64 body', () => {
		expect(Array.from(decodeMimeEncoding('aGVsbG8=', 'base64'))).toEqual([104, 101, 108, 108, 111])
	})

	it('decodes a quoted-printable body with an escaped byte', () => {
		const decoded = decodeMimeEncoding('Caf=C3=A9', 'quoted-printable')
		expect(decodeUtf8(decoded)).toBe('Café')
	})

	it('unwraps a quoted-printable soft line break (=CRLF)', () => {
		const decoded = decodeMimeEncoding('Hello=\r\nWorld', 'quoted-printable')
		expect(decodeUtf8(decoded)).toBe('HelloWorld')
	})

	it('treats an unknown encoding as raw text (utf-8 encoded)', () => {
		expect(Array.from(decodeMimeEncoding('hi', 'unknown-encoding'))).toEqual(
			Array.from(encodeUtf8('hi')),
		)
	})

	it('preserves a literal "=" when followed by a non-hex nibble (=3G is not consumed as 3)', () => {
		const decoded = decodeMimeEncoding('A=3GB', 'quoted-printable')
		expect(decodeUtf8(decoded)).toBe('A=3GB')
	})

	it('still decodes a valid escaped byte (=41 -> A)', () => {
		const decoded = decodeMimeEncoding('=41', 'quoted-printable')
		expect(decodeUtf8(decoded)).toBe('A')
	})
})

describe('decodeMimeText', () => {
	it('decodes a base64 body with the utf-8 charset', () => {
		const body = Buffer.from(encodeUtf8('café')).toString('base64')
		expect(decodeMimeText(body, 'base64', 'utf-8')).toBe('café')
	})

	it('decodes a base64 body with the iso-8859-1 charset', () => {
		expect(decodeMimeText('Y2Fm6Q==', 'base64', 'iso-8859-1')).toBe('café')
	})

	it('returns 7bit/8bit bodies unchanged', () => {
		expect(decodeMimeText('plain text', '7bit', 'utf-8')).toBe('plain text')
	})
})

describe('decodeMimeWords', () => {
	it('decodes a Base64 (B) encoded word', () => {
		expect(decodeMimeWords('=?UTF-8?B?SGVsbG8=?=')).toBe('Hello')
	})

	it('decodes a Quoted-Printable (Q) encoded word', () => {
		expect(decodeMimeWords('=?UTF-8?Q?Hello_World?=')).toBe('Hello World')
	})

	it('decodes a Quoted-Printable (Q) encoded word with an escaped byte', () => {
		expect(decodeMimeWords('=?UTF-8?Q?Caf=C3=A9?=')).toBe('Café')
	})

	it('decodes adjacent encoded words, dropping the whitespace between them (RFC 2047 6.2)', () => {
		expect(decodeMimeWords('=?UTF-8?B?SGVsbG8=?= =?UTF-8?B?IFdvcmxk?=')).toBe('Hello World')
	})

	it('leaves mixed plain text around an encoded word untouched', () => {
		expect(decodeMimeWords('plain =?UTF-8?B?SGVsbG8=?= more')).toBe('plain Hello more')
	})

	it('returns the input unchanged when there are no encoded words', () => {
		expect(decodeMimeWords('just plain text')).toBe('just plain text')
	})

	it('drops whitespace between two adjacent encoded words with identical content', () => {
		expect(decodeMimeWords('=?UTF-8?B?4pyT?= =?UTF-8?B?4pyT?=')).toBe('✓✓')
	})

	it('keeps surrounding spaces for a lone encoded word amid plain text', () => {
		expect(decodeMimeWords('plain =?UTF-8?B?4pyT?= plain')).toBe('plain ✓ plain')
	})
})

describe('formatEmailAddress', () => {
	it('formats a name and address together', () => {
		expect(formatEmailAddress('Alice', 'alice@example.com')).toBe('Alice <alice@example.com>')
	})

	it('formats an address alone when no name is given', () => {
		expect(formatEmailAddress(undefined, 'alice@example.com')).toBe('alice@example.com')
	})

	it('formats a name alone when no address is given', () => {
		expect(formatEmailAddress('Alice', undefined)).toBe('Alice')
	})

	it('returns an empty string when neither is given', () => {
		expect(formatEmailAddress(undefined, undefined)).toBe('')
	})
})

describe('extractMessage', () => {
	it('extracts from/to/cc/subject/date/text and a disposition attachment', () => {
		const raw = decodeUtf8(
			buildEml(
				[
					['From', 'Alice <alice@example.com>'],
					['To', 'bob@example.com, carol@example.com'],
					['Cc', 'dave@example.com'],
					['Subject', 'Hello'],
					['Date', 'Fri, 15 Mar 2024 12:34:56 GMT'],
					['Content-Type', 'multipart/mixed; boundary="AAA"'],
				],
				'--AAA\r\n' +
					'Content-Type: text/plain\r\n\r\n' +
					'Body text\r\n' +
					'--AAA\r\n' +
					'Content-Type: text/plain\r\n' +
					'Content-Disposition: attachment; filename="file.txt"\r\n\r\n' +
					'attachment content\r\n' +
					'--AAA--',
			),
		)

		const part = parseMimePart(raw)
		const message = extractMessage(part)

		expect(message.from).toBe('Alice <alice@example.com>')
		expect(message.to).toEqual(['bob@example.com', 'carol@example.com'])
		expect(message.cc).toEqual(['dave@example.com'])
		expect(message.subject).toBe('Hello')
		expect(message.date?.toUTCString()).toBe('Fri, 15 Mar 2024 12:34:56 GMT')
		expect(message.text).toBe('Body text')
		expect(message.html).toBe('')
		expect(message.attachments).toHaveLength(1)
		const [attachment] = message.attachments
		expect(attachment?.name).toBe('file.txt')
		expect(attachment?.mimeType).toBe('text/plain')
		expect(decodeUtf8(expectDefined(attachment).bytes)).toBe('attachment content')
	})

	it('leaves date undefined when the Date header is absent', () => {
		const raw = decodeUtf8(buildEml([['Content-Type', 'text/plain']], 'no date here'))
		const message = extractMessage(parseMimePart(raw))
		expect(message.date).toBeUndefined()
	})

	it('leaves date undefined when the Date header is malformed', () => {
		const raw = decodeUtf8(
			buildEml(
				[
					['Date', 'not a real date'],
					['Content-Type', 'text/plain'],
				],
				'body',
			),
		)
		const message = extractMessage(parseMimePart(raw))
		expect(message.date).toBeUndefined()
	})

	it('collects an html part separately from a text part', () => {
		const raw = decodeUtf8(
			buildEml(
				[['Content-Type', 'multipart/mixed; boundary="BBB"']],
				'--BBB\r\nContent-Type: text/plain\r\n\r\nplain body\r\n' +
					'--BBB\r\nContent-Type: text/html\r\n\r\n<p>html body</p>\r\n--BBB--',
			),
		)
		const message = extractMessage(parseMimePart(raw))
		expect(message.text).toBe('plain body')
		expect(message.html).toBe('<p>html body</p>')
	})
})
