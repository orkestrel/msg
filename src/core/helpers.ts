import type { Result, Success, Failure, EmailFormat, MIMEHeader, MSGEncoding } from './types.js'
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
 * Construct a {@link Success} wrapping a value.
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
 * Construct a {@link Failure} wrapping an error.
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
 * Narrow a Result to Success.
 *
 * @param result - Result to check
 * @returns True when result is Success
 */
export function isSuccess<T, E>(result: Result<T, E>): result is Success<T> {
	return result.success
}

/**
 * Narrow a Result to Failure.
 *
 * @param result - Result to check
 * @returns True when result is Failure
 */
export function isFailure<T, E>(result: Result<T, E>): result is Failure<E> {
	return !result.success
}

// === MSG Helpers

/**
 * Remove trailing null characters from a string.
 *
 * @param text - Input string
 * @returns String with trailing nulls removed
 */
export function removeTrailingNull(text: string): string {
	const index = text.indexOf('\0')
	if (index !== -1) {
		return text.substring(0, index)
	}
	return text
}

/**
 * Read a UTF-16LE string from a DataView.
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
	let result = ''
	for (let i = 0; i < charCount; i++) {
		const code = view.getUint16(offset + i * 2, true)
		result += String.fromCharCode(code)
	}
	return result
}

/**
 * Read a non-Unicode (PT_STRING8) string from a byte array using a
 * pure-ES decoder — no `TextDecoder` dependency, so this stays usable
 * in the core's DOM/Node-free environment.
 *
 * @param data - Binary data
 * @param encoding - Encoding to decode with (default `'windows-1252'`)
 * @returns Decoded string
 *
 * @example
 * ```ts
 * readANSIString(new Uint8Array([0x93, 0x41, 0x94])) // '“A”'
 * ```
 */
export function readANSIString(data: Uint8Array, encoding?: MSGEncoding): string {
	const resolved = encoding ?? 'windows-1252'
	if (resolved === 'utf-16le') {
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
		return readUTF16String(view, 0, Math.floor(data.length / 2))
	}
	if (resolved === 'utf-8') return decodeUTF8(data)
	if (resolved === 'latin1') return decodeLatin1(data)
	return decodeWindows1252(data)
}

/**
 * Convert a Windows FILETIME (100-ns intervals since 1601-01-01) to a UTC date string.
 * Combines the low/high 32-bit halves with `BigInt` so the 64-bit interval
 * count never loses precision to float64 rounding.
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
 * Convert a number to a lowercase hex string with specified padding.
 *
 * @param value - Number to convert
 * @param length - Minimum hex string length (zero-padded)
 * @returns Lowercase hex string
 */
export function toHexLower(value: number, length: number): string {
	const hex = '0123456789abcdef'
	let result = ''
	let remaining = value >>> 0
	for (let i = 0; i < length; i++) {
		result = hex.charAt(remaining & 15) + result
		remaining = remaining >>> 4
	}
	return result
}

/**
 * Stringify a mixed-endian Microsoft UUID from a byte array.
 *
 * @param data - Byte array containing the UUID
 * @param offset - Byte offset to start reading
 * @returns UUID string in lowercase
 */
export function msftUUIDStringify(data: Uint8Array, offset: number): string {
	const order = [3, 2, 1, 0, 5, 4, 7, 6, 8, 9, 10, 11, 12, 13, 14, 15]
	let result = ''
	for (const [index, relative] of order.entries()) {
		if (index === 4 || index === 6 || index === 8 || index === 10) result += '-'
		const byte = data[offset + relative]
		if (byte === undefined) {
			throw new MSGError('RANGE', 'UUID byte offset is out of range', {
				offset: offset + relative,
			})
		}
		result += toHexLower(byte, 2)
	}
	return result
}

/**
 * Validate that a DataView starts with the CFB magic header.
 *
 * @param view - DataView to check
 * @returns True when the first 8 bytes match the CFB signature
 */
export function isMSGFile(view: DataView): boolean {
	if (view.byteLength < MSG_FILE_HEADER.length) return false
	for (let i = 0; i < MSG_FILE_HEADER.length; i++) {
		if (view.getUint8(i) !== MSG_FILE_HEADER[i]) return false
	}
	return true
}

// === MSGBurner Helpers

/**
 * Round a value up to the nearest multiple of a boundary.
 *
 * @param value - Number to round
 * @param boundary - Must be a power of 2
 * @returns Rounded value
 */
export function roundUpToMultiple(value: number, boundary: number): number {
	return (value + boundary - 1) & ~(boundary - 1)
}

/**
 * Compute how many sectors are needed to hold a given byte count.
 *
 * @param bytes - Total byte count
 * @param sectorSize - Sector size in bytes
 * @returns Number of sectors (0 when bytes ≤ 0)
 */
export function sectorsNeeded(bytes: number, sectorSize: number): number {
	if (bytes <= 0) return 0
	return roundUpToMultiple(bytes, sectorSize) / sectorSize
}

/**
 * CFB-compliant directory name comparator.
 * Compares by UTF-16 length first, then by uppercased code points.
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
 * Decode a Base64 string into raw bytes without relying on `atob`.
 * Ignores ASCII whitespace and tolerates missing padding.
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
	const bytes: number[] = []
	let buffer = 0
	let bits = 0

	for (const char of cleaned) {
		const index = alphabet.indexOf(char)
		if (index === -1) {
			throw new MSGError('MALFORMED', `Invalid Base64 character: ${char}`, { char })
		}
		buffer = (buffer << 6) | index
		bits += 6
		if (bits >= 8) {
			bits -= 8
			bytes.push((buffer >> bits) & 0xff)
		}
	}

	return new Uint8Array(bytes)
}

/**
 * Encode a string into UTF-8 bytes, handling surrogate pairs.
 * A lone (unpaired) surrogate encodes as U+FFFD.
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
	const bytes: number[] = []

	for (let i = 0; i < text.length; i++) {
		let code = text.charCodeAt(i)

		if (code >= 0xd800 && code <= 0xdbff) {
			const next = text.charCodeAt(i + 1)
			if (next >= 0xdc00 && next <= 0xdfff) {
				code = (code - 0xd800) * 0x400 + (next - 0xdc00) + 0x10000
				i++
			} else {
				code = 0xfffd
			}
		} else if (code >= 0xdc00 && code <= 0xdfff) {
			code = 0xfffd
		}

		if (code < 0x80) {
			bytes.push(code)
		} else if (code < 0x800) {
			bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f))
		} else if (code < 0x10000) {
			bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f))
		} else {
			bytes.push(
				0xf0 | (code >> 18),
				0x80 | ((code >> 12) & 0x3f),
				0x80 | ((code >> 6) & 0x3f),
				0x80 | (code & 0x3f),
			)
		}
	}

	return new Uint8Array(bytes)
}

/**
 * Decode UTF-8 bytes into a string, WHATWG-style: an invalid byte
 * sequence decodes as U+FFFD rather than throwing. Rejects overlong
 * encodings, surrogate code points (0xD800-0xDFFF), and code points
 * beyond 0x10FFFF — each invalid sequence yields exactly one U+FFFD
 * and decoding resumes at the next lead byte.
 *
 * @param bytes - UTF-8 byte array
 * @returns Decoded string
 *
 * @example
 * ```ts
 * decodeUTF8(new Uint8Array([65])) // 'A'
 * decodeUTF8(new Uint8Array([0xff])) // '�'
 * ```
 */
export function decodeUTF8(bytes: Uint8Array): string {
	let result = ''
	let i = 0

	while (i < bytes.length) {
		const byte0 = bytes[i]
		if (byte0 === undefined) break

		if (byte0 < 0x80) {
			result += String.fromCharCode(byte0)
			i++
			continue
		}

		let length = 0
		let codePoint = 0
		if ((byte0 & 0xe0) === 0xc0) {
			length = 1
			codePoint = byte0 & 0x1f
		} else if ((byte0 & 0xf0) === 0xe0) {
			length = 2
			codePoint = byte0 & 0x0f
		} else if ((byte0 & 0xf8) === 0xf0) {
			length = 3
			codePoint = byte0 & 0x07
		} else {
			result += '�'
			i++
			continue
		}

		if (i + length >= bytes.length) {
			result += '�'
			i++
			continue
		}

		let valid = true
		let value = codePoint
		for (let j = 1; j <= length; j++) {
			const next = bytes[i + j]
			if (next === undefined) {
				valid = false
				break
			}
			if ((next & 0xc0) !== 0x80) {
				valid = false
				break
			}
			value = (value << 6) | (next & 0x3f)
		}

		if (!valid) {
			result += '�'
			i++
			continue
		}

		const minimum = UTF8_SEQUENCE_MINIMUM[length]
		const isOverlong = minimum !== undefined && value < minimum
		const isSurrogate = value >= 0xd800 && value <= 0xdfff
		const isOutOfRange = value > 0x10ffff

		if (isOverlong || isSurrogate || isOutOfRange) {
			result += '�'
			i += length + 1
			continue
		}

		i += length + 1

		if (value >= 0x10000) {
			value -= 0x10000
			result += String.fromCharCode(0xd800 + (value >> 10), 0xdc00 + (value & 0x3ff))
		} else {
			result += String.fromCharCode(value)
		}
	}

	return result
}

/**
 * Decode Latin-1 (ISO-8859-1) bytes into a string, byte-for-code-point.
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
	let result = ''
	for (const byte of bytes) {
		result += String.fromCharCode(byte)
	}
	return result
}

/**
 * Decode Windows-1252 bytes into a string. Identical to {@link decodeLatin1}
 * except for the 0x80-0x9F range, which maps through {@link WINDOWS_1252_HIGH}.
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
	let result = ''
	for (const byte of bytes) {
		if (byte >= 0x80 && byte <= 0x9f) {
			const codePoint = WINDOWS_1252_HIGH[byte - 0x80]
			if (codePoint === undefined) {
				throw new MSGError('MALFORMED', 'Windows-1252 mapping is incomplete', { byte })
			}
			result += String.fromCodePoint(codePoint)
		} else {
			result += String.fromCharCode(byte)
		}
	}
	return result
}

/**
 * Resolve a free-form charset label (as seen in a MIME `charset` parameter)
 * to a supported {@link MSGEncoding}. Unknown or absent labels fall back
 * to {@link FALLBACK_CHARSET}.
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
 * Derive the EmailFormat from a file name and/or MIME type.
 * Returns undefined when the format cannot be determined.
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
 * Parse headers from a raw RFC 2822 / MIME header text block.
 *
 * @param text - Raw header text
 * @returns Map of parsed header objects
 */
export function parseMIMEHeaders(text: string): ReadonlyMap<string, MIMEHeader> {
	const raw: Array<{ name: string; value: string }> = []

	for (const line of text.split('\n')) {
		if (line === '') continue
		if ((line.startsWith(' ') || line.startsWith('\t')) && raw.length > 0) {
			const last = raw[raw.length - 1]
			if (last !== undefined) {
				raw[raw.length - 1] = { name: last.name, value: last.value + ' ' + line.trim() }
			}
			continue
		}
		const colon = line.indexOf(':')
		if (colon === -1) continue
		raw.push({
			name: line.slice(0, colon).trim().toLowerCase(),
			value: line.slice(colon + 1).trim(),
		})
	}

	const map = new Map<string, MIMEHeader>()
	for (const { name, value } of raw) {
		if (!map.has(name)) {
			const segments = value.split(';')
			const val = (segments[0] ?? '').trim()
			const params = new Map<string, string>()

			for (let i = 1; i < segments.length; i++) {
				const segment = (segments[i] ?? '').trim()
				const eq = segment.indexOf('=')
				if (eq === -1) continue
				const k = segment.slice(0, eq).trim().toLowerCase()
				let v = segment.slice(eq + 1).trim()
				if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
				params.set(k, v)
			}

			map.set(name, { value: val, params })
		}
	}
	return map
}

/**
 * Decode a MIME-encoded body string into a raw byte array.
 *
 * @param body - Raw encoded string
 * @param encoding - Encoding type (e.g., 'base64', 'quoted-printable')
 * @returns Decoded byte array
 * @throws {@link MSGError} with code `MALFORMED` when `encoding` is `'base64'`
 * and `body` contains an invalid Base64 character
 */
export function decodeMIMEEncoding(body: string, encoding: string): Uint8Array {
	const enc = encoding.toLowerCase()

	if (enc === 'base64') {
		return decodeBase64(body)
	}

	if (enc === 'quoted-printable') {
		const unwrapped = body.replace(/=\r?\n/g, '')
		const result: number[] = []
		let i = 0

		while (i < unwrapped.length) {
			if (unwrapped[i] === '=' && i + 2 < unwrapped.length) {
				const hex = unwrapped.slice(i + 1, i + 3)
				if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
					result.push(parseInt(hex, 16))
					i += 3
					continue
				}
			}
			result.push(unwrapped.charCodeAt(i))
			i++
		}

		return new Uint8Array(result)
	}

	return encodeUTF8(body)
}

/**
 * Decode a MIME-encoded body into a text string based on an arbitrary
 * charset label, resolved via {@link resolveEncoding}.
 *
 * @param body - Raw encoded string
 * @param encoding - Transfer encoding type
 * @param charset - Character set label (e.g., 'utf-8')
 * @returns Decoded string
 */
export function decodeMIMEText(body: string, encoding: string, charset: string): string {
	const enc = encoding.toLowerCase()
	if (enc !== 'base64' && enc !== 'quoted-printable') {
		return body // Return directly for 7bit/8bit text
	}
	const bytes = decodeMIMEEncoding(body, encoding)
	return readANSIString(bytes, resolveEncoding(charset))
}

/**
 * Decode RFC 2047 encoded words in header values.
 * Handles both Base64 (B) and Quoted-Printable (Q) forms.
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
			try {
				const upper = enc.toUpperCase()
				const bytes =
					upper === 'B'
						? decodeMIMEEncoding(encoded, 'base64')
						: decodeMIMEEncoding(encoded.replace(/_/g, ' '), 'quoted-printable')
				return readANSIString(bytes, resolveEncoding(charset))
			} catch {
				return encoded
			}
		},
	)
}

/**
 * Format a name and email into a standard composite address.
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
 * Infers the file extension for an attachment based on its filename or MIME type.
 * Returns the extension including the dot (e.g., '.jpg').
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
			// Basic validation: extension should be alphanumeric and reasonably short
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
