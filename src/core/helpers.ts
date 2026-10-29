import { attempt, type Failure, type Result, type Success } from '@orkestrel/contract'
import type { EmailFormat, MIMEHeader, MSGEncoding } from './types.js'
import { MSGError } from './errors.js'
import {
	EML_EXTENSIONS,
	EML_MIME_TYPES,
	FALLBACK_CHARSET,
	MIME_EXTENSIONS,
	MSG_EXTENSIONS,
	MSG_FILE_HEADER,
	MSG_MIME_TYPES,
	UTF8_SEQUENCE_MINIMUM,
	WINDOWS_1252_HIGH,
} from './constants.js'

// === Result Helpers

/**
 * Constructs a {@link Success} wrapping a value.
 *
 * @param value - The value to wrap
 * @returns A `Success<T>` result
 *
 * @example
 * ```ts
 * const result = success(42) // { success: true, value: 42 }
 * ```
 */
export function success<T>(value: T): Success<T> {
	return { success: true, value }
}

/**
 * Constructs a {@link Failure} wrapping an error.
 *
 * @param error - The error to wrap
 * @returns A `Failure<E>` result
 *
 * @example
 * ```ts
 * const result = failure(new MSGError('MALFORMED', 'bad input'))
 * ```
 */
export function failure<E>(error: E): Failure<E> {
	return { success: false, error }
}

/**
 * Narrows a {@link Result} to a {@link Success}.
 *
 * @param result - Result to check
 * @returns True if result is Success; false otherwise
 */
export function isSuccess<T, E>(result: Result<T, E>): result is Success<T> {
	return result.success
}

/**
 * Narrows a {@link Result} to a {@link Failure}.
 *
 * @param result - Result to check
 * @returns True if result is Failure; false otherwise
 */
export function isFailure<T, E>(result: Result<T, E>): result is Failure<E> {
	return !result.success
}

// === MSG Helpers

/**
 * Truncates a string at its first `\0` character.
 *
 * @param text - Input string
 * @returns The text before the first NUL, or the whole text when it carries none
 */
export function truncateAtNull(text: string): string {
	const index = text.indexOf('\0')
	if (index !== -1) {
		return text.substring(0, index)
	}
	return text
}

/**
 * Reads a UTF-16LE string out of a `DataView`, throwing when the requested range exceeds the
 * view's bounds.
 *
 * @param view - DataView to read from
 * @param offset - Byte offset to start reading
 * @param charCount - Number of UTF-16 code units to read
 * @returns Decoded string
 * @throws {@link MSGError} with code `MALFORMED` when the requested range
 * exceeds the view's bounds
 */
export function readUTF16String(view: DataView, offset: number, charCount: number): string {
	const end = offset + charCount * 2
	if (offset < 0 || charCount < 0 || end > view.byteLength) {
		throw new MSGError('MALFORMED', 'UTF-16 string range exceeds view bounds', {
			offset,
			charCount,
			byteLength: view.byteLength,
		})
	}
	const characters = Array.from({ length: Math.ceil(charCount) }, (_, index) =>
		String.fromCharCode(view.getUint16(offset + index * 2, true)),
	)
	return characters.join('')
}

/**
 * Decodes bytes into a string with a pure-ES decoder, dispatching on the named encoding. Default:
 * `windows-1252`.
 *
 * @remarks
 * Every branch runs a pure-ES decoder — no `TextDecoder` dependency — so this stays usable in the
 * core's DOM/Node-free environment.
 *
 * @param bytes - Binary data
 * @param encoding - Encoding to decode with. Default: `'windows-1252'`
 * @returns Decoded string
 *
 * @example
 * ```ts
 * decodeText(new Uint8Array([0x93, 0x41, 0x94])) // '“A”'
 * ```
 */
export function decodeText(bytes: Uint8Array, encoding?: MSGEncoding): string {
	const resolved = encoding ?? 'windows-1252'
	if (resolved === 'utf-16le') {
		const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		return readUTF16String(view, 0, Math.floor(bytes.length / 2))
	}
	if (resolved === 'utf-8') return decodeUTF8(bytes)
	if (resolved === 'latin1') return decodeLatin1(bytes)
	return decodeWindows1252(bytes)
}

/**
 * Converts a Windows FILETIME (100-ns ticks since 1601-01-01) to a UTC date string.
 *
 * @remarks
 * Combines the low and high 32-bit halves with `BigInt`, so the 64-bit interval count never loses
 * precision to float64 rounding.
 *
 * @param low - Low 32 bits of FILETIME
 * @param high - High 32 bits of FILETIME
 * @returns UTC date string
 */
export function fileTimeToUTCString(low: number, high: number): string {
	const fileTime = BigInt(low >>> 0) + (BigInt(high >>> 0) << 32n)
	const unixMs = (fileTime - 116444736000000000n) / 10000n
	return new Date(Number(unixMs)).toUTCString()
}

/**
 * Converts a number to a zero-padded lowercase hex string of the requested digit count.
 *
 * @param value - Number to convert
 * @param length - Minimum hex string length (zero-padded)
 * @returns Lowercase hex string
 */
export function toHexLower(value: number, length: number): string {
	const hex = '0123456789abcdef'
	const digits = Array.from({ length: Math.max(0, Math.ceil(length)) }, (_, index) => {
		if (index >= 8) return '0'
		const shifted = value >>> (index * 4)
		return hex.charAt(shifted & 15)
	})
	return digits.reverse().join('')
}

/**
 * Reads a mixed-endian Microsoft UUID starting at an offset in a byte array, throwing past the
 * array's bounds.
 *
 * @param bytes - Byte array containing the UUID
 * @param offset - Byte offset to start reading
 * @returns UUID string in lowercase
 * @throws {@link MSGError} with code `RANGE` when the UUID range exceeds the
 * array's bounds
 */
export function readMicrosoftUUID(bytes: Uint8Array, offset: number): string {
	const order = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15]
	return order
		.map((relative, index) => {
			const separator = index === 4 || index === 6 || index === 8 || index === 10 ? '-' : ''
			const byte = bytes[offset + relative]
			if (byte === undefined) {
				throw new MSGError('RANGE', 'UUID byte offset is out of range', {
					offset: offset + relative,
				})
			}
			return separator + toHexLower(byte, 2)
		})
		.join('')
}

/**
 * Reports whether a `DataView`'s first 8 bytes match the CFB magic signature.
 *
 * @param view - DataView to check
 * @returns True if the first 8 bytes match the CFB signature; false otherwise
 */
export function isMSGFile(view: DataView): boolean {
	if (view.byteLength < MSG_FILE_HEADER.length) return false
	return MSG_FILE_HEADER.every((byte, index) => view.getUint8(index) === byte)
}

// === MSGBurner Helpers

/**
 * Rounds a value up to the nearest multiple of a boundary, which must be a power of 2.
 *
 * @param value - Number to round
 * @param boundary - Must be a power of 2
 * @returns Rounded value
 */
export function roundUpToMultiple(value: number, boundary: number): number {
	return (value + boundary - 1) & ~(boundary - 1)
}

/**
 * Computes how many sectors of a given size hold a byte count, answering 0 for a count at or
 * below zero.
 *
 * @param bytes - Total byte count
 * @param sectorSize - Sector size in bytes
 * @returns Number of sectors (0 when bytes ≤ 0)
 */
export function computeSectors(bytes: number, sectorSize: number): number {
	if (bytes <= 0) return 0
	return roundUpToMultiple(bytes, sectorSize) / sectorSize
}

/**
 * Orders two directory names as the compound file format requires, comparing by UTF-16 length
 * first and then by uppercased code points.
 *
 * @param a - First name
 * @param b - Second name
 * @returns Negative, zero, or positive
 */
export function compareCFBName(a: string, b: string): number {
	const diff = a.length - b.length
	if (diff !== 0) return diff
	const x = a.toUpperCase()
	const y = b.toUpperCase()
	if (x > y) return 1
	if (x < y) return -1
	return 0
}

// === Pure-ES Encoding Decoders

/**
 * Decodes a Base64 string into raw bytes without relying on `atob`, ignoring ASCII whitespace and
 * tolerating missing padding.
 *
 * @param text - Base64-encoded string
 * @returns Decoded byte array
 * @throws {@link MSGError} with code `MALFORMED` when the string contains
 * a character outside the Base64 alphabet
 *
 * @example
 * ```ts
 * decodeBase64('SGVsbG8=') // Uint8Array [72, 101, 108, 108, 111]
 * ```
 */
export function decodeBase64(text: string): Uint8Array {
	const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
	const cleaned = text.replace(/[ \t\n\r\f\v]+/g, '').replace(/=+$/, '')
	const steps: Array<{
		readonly buffer: number
		readonly bits: number
		readonly byte?: number
	}> = []
	for (const char of cleaned) {
		const index = alphabet.indexOf(char)
		if (index === -1) {
			throw new MSGError('MALFORMED', `Invalid Base64 character: ${char}`, { char })
		}
		const previous = steps.at(-1)
		const buffer = ((previous?.buffer ?? 0) << 6) | index
		const bits = (previous?.bits ?? 0) + 6
		steps.push(
			bits >= 8
				? { buffer, bits: bits - 8, byte: (buffer >> (bits - 8)) & 0xff }
				: { buffer, bits },
		)
	}
	return new Uint8Array(steps.flatMap((step) => (step.byte === undefined ? [] : [step.byte])))
}

/**
 * Encodes a string into UTF-8 bytes, pairing surrogates and encoding a lone (unpaired) surrogate
 * as U+FFFD.
 *
 * @param text - String to encode
 * @returns UTF-8 byte array
 *
 * @example
 * ```ts
 * encodeUTF8('A') // Uint8Array [65]
 * ```
 */
export function encodeUTF8(text: string): Uint8Array {
	return new Uint8Array(
		Array.from(text).flatMap((character) => {
			const point = character.codePointAt(0) ?? 0
			const code = point >= 0xd800 && point <= 0xdfff ? 0xfffd : point
			if (code < 0x80) return [code]
			if (code < 0x800) return [0xc0 | (code >> 6), 0x80 | (code & 0x3f)]
			if (code < 0x10000) {
				return [0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f)]
			}
			return [
				0xf0 | (code >> 18),
				0x80 | ((code >> 12) & 0x3f),
				0x80 | ((code >> 6) & 0x3f),
				0x80 | (code & 0x3f),
			]
		}),
	)
}

/**
 * Decodes UTF-8 bytes into a string WHATWG-style: an invalid byte sequence decodes as U+FFFD
 * rather than throwing.
 *
 * @remarks
 * Rejects an overlong encoding, a surrogate code point (`0xD800`-`0xDFFF`), and a code point
 * beyond `0x10FFFF`. Each invalid sequence yields exactly one U+FFFD, and decoding resumes at the
 * next lead byte.
 *
 * @param bytes - UTF-8 byte array
 * @returns Decoded string
 *
 * @example
 * ```ts
 * decodeUTF8(new Uint8Array([65])) // 'A'
 * decodeUTF8(new Uint8Array([0xff])) // '\uFFFD'
 * ```
 */
export function decodeUTF8(bytes: Uint8Array): string {
	const steps: Array<{ readonly text: string; readonly next: number }> = []
	while (true) {
		const index = steps.at(-1)?.next ?? 0
		if (index >= bytes.length) break
		const byte = bytes[index]
		if (byte === undefined) break
		if (byte < 0x80) {
			steps.push({ text: String.fromCharCode(byte), next: index + 1 })
			continue
		}
		const length =
			(byte & 0xe0) === 0xc0 ? 1 : (byte & 0xf0) === 0xe0 ? 2 : (byte & 0xf8) === 0xf0 ? 3 : 0
		const mask = length === 1 ? 0x1f : length === 2 ? 0x0f : 0x07
		const point = byte & mask
		if (length === 0 || index + length >= bytes.length) {
			steps.push({ text: '\uFFFD', next: index + 1 })
			continue
		}
		const offsets = Array.from({ length }, (_, offset) => offset + 1)
		const value = offsets.reduce<number | undefined>((previous, offset) => {
			if (previous === undefined) return undefined
			const next = bytes[index + offset]
			if (next === undefined || (next & 0xc0) !== 0x80) return undefined
			return (previous << 6) | (next & 0x3f)
		}, point)
		if (value === undefined) {
			steps.push({ text: '\uFFFD', next: index + 1 })
			continue
		}
		const minimum = UTF8_SEQUENCE_MINIMUM[length]
		const invalid =
			(minimum !== undefined && value < minimum) ||
			(value >= 0xd800 && value <= 0xdfff) ||
			value > 0x10ffff
		const text = invalid ? '\uFFFD' : String.fromCodePoint(value)
		steps.push({ text, next: index + length + 1 })
	}
	return steps.map((step) => step.text).join('')
}

/**
 * Decodes Latin-1 (ISO-8859-1) bytes into a string, byte-for-code-point.
 *
 * @param bytes - Latin-1 byte array
 * @returns Decoded string
 *
 * @example
 * ```ts
 * decodeLatin1(new Uint8Array([0xe9])) // 'é'
 * ```
 */
export function decodeLatin1(bytes: Uint8Array): string {
	return Iterator.from(bytes)
		.map((byte) => String.fromCharCode(byte))
		.toArray()
		.join('')
}

/**
 * Decodes Windows-1252 bytes into a string, resolving the `0x80`-`0x9F` range through
 * {@link WINDOWS_1252_HIGH} and otherwise matching {@link decodeLatin1}.
 *
 * @param bytes - Windows-1252 byte array
 * @returns Decoded string
 *
 * @example
 * ```ts
 * decodeWindows1252(new Uint8Array([0x93])) // '“'
 * ```
 */
export function decodeWindows1252(bytes: Uint8Array): string {
	return Iterator.from(bytes)
		.map((byte) => {
			if (byte >= 0x80 && byte <= 0x9f) {
				const codePoint = WINDOWS_1252_HIGH[byte - 0x80]
				if (codePoint === undefined) {
					throw new MSGError('MALFORMED', 'Windows-1252 mapping is incomplete', { byte })
				}
				return String.fromCodePoint(codePoint)
			}
			return String.fromCharCode(byte)
		})
		.toArray()
		.join('')
}

/**
 * Resolves a free-form charset label, as a MIME `charset` parameter carries it, to a supported
 * {@link MSGEncoding}, falling back to {@link FALLBACK_CHARSET}'s encoding for an unrecognized or
 * absent label.
 *
 * @param label - Charset label to resolve (case-insensitive)
 * @returns Resolved encoding
 *
 * @example
 * ```ts
 * resolveEncoding('ISO-8859-1') // 'latin1'
 * resolveEncoding(undefined) // 'utf-8'
 * ```
 */
export function resolveEncoding(label: string | undefined): MSGEncoding {
	const lower = label?.trim().toLowerCase()
	if (lower === 'utf-8' || lower === 'utf8') return 'utf-8'
	if (lower === 'utf-16le' || lower === 'utf-16') return 'utf-16le'
	if (lower === 'windows-1252' || lower === 'cp1252') return 'windows-1252'
	if (
		lower === 'us-ascii' ||
		lower === 'ascii' ||
		lower === 'iso-8859-1' ||
		lower === 'iso8859-1' ||
		lower === 'latin1'
	) {
		return 'latin1'
	}
	return FALLBACK_CHARSET
}

// === EmailParser Helpers

/**
 * Derives the {@link EmailFormat} from a file name, a MIME type, or both, answering `undefined`
 * when neither hints at a format.
 *
 * @param name - File name to inspect
 * @param mime - MIME type to inspect
 * @returns Detected format or undefined
 *
 * @example
 * ```ts
 * detectFormat('message.eml', undefined) // 'eml'
 * detectFormat(undefined, 'application/vnd.ms-outlook') // 'msg'
 * ```
 */
export function detectFormat(
	name: string | undefined,
	mime: string | undefined,
): EmailFormat | undefined {
	const lower = name?.toLowerCase()

	if (lower !== undefined) {
		if (EML_EXTENSIONS.some((extension) => lower.endsWith(extension))) return 'eml'
		if (MSG_EXTENSIONS.some((extension) => lower.endsWith(extension))) return 'msg'
	}

	if (mime !== undefined) {
		if (EML_MIME_TYPES.includes(mime)) return 'eml'
		if (MSG_MIME_TYPES.includes(mime)) return 'msg'
	}

	return undefined
}

/**
 * Parses an RFC 2822 / MIME header block, folding continuation lines.
 *
 * @param text - Raw header text
 * @returns Map of parsed header objects
 */
export function parseMIMEHeaders(text: string): ReadonlyMap<string, MIMEHeader> {
	const initial: ReadonlyArray<{ readonly name: string; readonly parts: readonly string[] }> = []
	const raw = text.split(/\r\n|\n/).reduce((headers, line) => {
		if (line === '') return headers
		const last = headers.at(-1)
		if ((line.startsWith(' ') || line.startsWith('\t')) && last !== undefined) {
			const folded = { name: last.name, parts: [...last.parts, line.trim()] }
			return [...headers.slice(0, -1), folded]
		}
		const colon = line.indexOf(':')
		if (colon === -1) return headers
		const header = {
			name: line.slice(0, colon).trim().toLowerCase(),
			parts: [line.slice(colon + 1).trim()],
		}
		return [...headers, header]
	}, initial)
	const unique = raw.filter(
		(header, index) => raw.findIndex((candidate) => candidate.name === header.name) === index,
	)
	const entries = unique.map(({ name, parts }) => {
		const segments = parts.join(' ').split(';')
		const params = segments.slice(1).flatMap((part) => {
			const segment = part.trim()
			const equal = segment.indexOf('=')
			if (equal === -1) return []
			const key = segment.slice(0, equal).trim().toLowerCase()
			const value = segment.slice(equal + 1).trim()
			const quoted = value.startsWith('"') && value.endsWith('"')
			const unquoted = quoted ? value.slice(1, -1) : value
			return [[key, unquoted] as const]
		})
		return [name, { value: (segments[0] ?? '').trim(), params: new Map(params) }] as const
	})
	return new Map(entries)
}

/**
 * Decodes a MIME body — `base64`, `quoted-printable`, or passthrough — into raw bytes, throwing
 * on invalid Base64.
 *
 * @param body - Raw encoded string
 * @param encoding - Encoding type, for example 'base64' or 'quoted-printable'
 * @returns Decoded byte array
 * @throws {@link MSGError} with code `MALFORMED` when `encoding` is `'base64'`
 * and `body` contains an invalid Base64 character
 */
export function decodeMIMEEncoding(body: string, encoding: string): Uint8Array {
	const enc = encoding.toLowerCase()
	if (enc === 'base64') return decodeBase64(body)
	if (enc === 'quoted-printable') {
		const unwrapped = body.replace(/=\r?\n/g, '')
		return new Uint8Array(
			Array.from(unwrapped.matchAll(/=[0-9A-Fa-f]{2}|[\s\S]/g), (match) =>
				match[0].length === 3 ? parseInt(match[0].slice(1), 16) : match[0].charCodeAt(0),
			),
		)
	}
	return encodeUTF8(body)
}

/**
 * Decodes a MIME body to text through {@link decodeMIMEEncoding} and {@link resolveEncoding},
 * taking the charset from a free-form label.
 *
 * @param body - Raw encoded string
 * @param encoding - Transfer encoding type
 * @param charset - Character set label, for example 'utf-8'
 * @returns Decoded string
 */
export function decodeMIMEText(body: string, encoding: string, charset: string): string {
	const enc = encoding.toLowerCase()
	if (enc !== 'base64' && enc !== 'quoted-printable') {
		return body // Return directly for 7bit/8bit text
	}
	const bytes = decodeMIMEEncoding(body, encoding)
	return decodeText(bytes, resolveEncoding(charset))
}

/**
 * Decodes the RFC 2047 encoded words (`=?charset?B/Q?...?=`) in a header value, reading the
 * Base64 (`B`) and quoted-printable (`Q`) forms alike.
 *
 * @param text - Header value string potentially containing encoded words
 * @returns Decoded string
 *
 * @example
 * ```ts
 * decodeMIMEWords('=?UTF-8?B?SGVsbG8=?=') // 'Hello'
 * ```
 */
export function decodeMIMEWords(text: string): string {
	// RFC 2047 6.2: linear whitespace between two adjacent encoded-words is
	// part of the encoding, not content — drop it before decoding.
	const collapsed = text.replace(
		/(=\?[^?]+\?[BbQq]\?[^?]*\?=)[ \t\r\n]+(?==\?[^?]+\?[BbQq]\?[^?]*\?=)/g,
		'$1',
	)
	return collapsed.replace(
		/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g,
		(_match, charset: string, enc: string, encoded: string) => {
			const outcome = attempt(() => {
				const upper = enc.toUpperCase()
				const bytes =
					upper === 'B'
						? decodeMIMEEncoding(encoded, 'base64')
						: decodeMIMEEncoding(encoded.replace(/_/g, ' '), 'quoted-printable')
				return decodeText(bytes, resolveEncoding(charset))
			})
			return outcome.success ? outcome.value : encoded
		},
	)
}

/**
 * Formats a display name and an email address into `"Name <email>"`, or into whichever half is
 * present.
 *
 * @param name - Display name
 * @param email - Email address
 * @returns Formatted address string
 */
export function formatEmailAddress(name: string | undefined, email: string | undefined): string {
	const n = name?.trim() ?? ''
	const e = email?.trim() ?? ''
	if (n.length > 0 && e.length > 0) return `${n} <${e}>`
	if (n.length > 0) return n
	return e
}

// === Attachment Helpers

/**
 * Infers an attachment's file extension from its file name or its MIME type, returning the
 * extension with its leading dot and falling back to `.bin`.
 *
 * @param mimeType - MIME type to infer from
 * @param fileName - File name to infer from
 * @returns Inferred extension, or `.bin` when neither hint resolves
 */
export function inferExtension(mimeType?: string, fileName?: string): string {
	if (fileName !== undefined) {
		const lastDotIndex = fileName.lastIndexOf('.')
		if (lastDotIndex !== -1 && lastDotIndex < fileName.length - 1) {
			const ext = fileName.slice(lastDotIndex).toLowerCase()
			if (/^\.[a-z0-9]{1,10}$/.test(ext)) {
				return ext
			}
		}
	}

	if (mimeType !== undefined) {
		const normalized = mimeType.split(';')[0]?.trim().toLowerCase()
		if (normalized !== undefined) {
			const ext = MIME_EXTENSIONS.get(normalized)
			if (ext !== undefined) return ext
		}
	}

	return '.bin'
}
