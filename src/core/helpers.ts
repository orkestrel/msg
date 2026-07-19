import type {
	Result,
	Success,
	Failure,
	EmailFormat,
	MIMEHeader,
	MSGEncoding,
	MSGBurnerEntry,
	MSGBurnerLiteEntry,
} from './types.js'
import { MSGError } from './errors.js'
import { decodeUTF8 } from './parsers.js'
import {
	MIME_EXTENSIONS,
	WINDOWS_1252_HIGH,
	MSG_FILE_HEADER,
	MSG_TYPE_DIRECTORY,
	MSG_TYPE_DOCUMENT,
	MSG_END_OF_CHAIN,
	MSG_UNUSED_BLOCK,
	MSG_BURNER_SECTOR_SIZE,
	MSG_BURNER_MINI_SECTOR_SIZE,
	MSG_BURNER_MINI_STREAM_CUTOFF,
	MSG_BURNER_INTS_PER_SECTOR,
	MSG_BURNER_DIFAT_HEADER_SLOTS,
	MSG_BURNER_DIR_ENTRY_SIZE,
	MSG_BURNER_FAT_SECTOR_MARKER,
	MSG_BURNER_DIFAT_SECTOR_MARKER,
	MSG_BURNER_ROOT_CLSID,
	MSG_BURNER_NAME_MAX,
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

/**
 * Narrow an unknown value to a plain record.
 *
 * @param value - Value to check
 * @returns True when value is a non-null, non-array object
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
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
		result = hex[remaining & 15] + result
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
	const hex = '0123456789abcdef'
	const b = (i: number) => hex[(data[offset + i] >> 4) & 15] + hex[data[offset + i] & 15]
	return (
		b(3) +
		b(2) +
		b(1) +
		b(0) +
		'-' +
		b(5) +
		b(4) +
		'-' +
		b(7) +
		b(6) +
		'-' +
		b(8) +
		b(9) +
		'-' +
		b(10) +
		b(11) +
		b(12) +
		b(13) +
		b(14) +
		b(15)
	)
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
	for (let i = 0; i < bytes.length; i++) {
		result += String.fromCharCode(bytes[i])
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
	for (let i = 0; i < bytes.length; i++) {
		const byte = bytes[i]
		if (byte >= 0x80 && byte <= 0x9f) {
			result += String.fromCodePoint(WINDOWS_1252_HIGH[byte - 0x80])
		} else {
			result += String.fromCharCode(byte)
		}
	}
	return result
}

/**
 * Resolve a free-form charset label (as seen in a MIME `charset` parameter)
 * to a supported {@link MSGEncoding}. Unknown or absent labels fall back
 * to `'utf-8'`.
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
	return 'utf-8'
}

// === EmailParser Helpers

/**
 * Narrow an unknown value to a valid EmailFormat.
 *
 * @param value - Value to check
 * @returns True when value is 'eml' or 'msg'
 */
export function isEmailFormat(value: unknown): value is EmailFormat {
	return value === 'eml' || value === 'msg'
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

// === MSGBurner (CFB writer)

/**
 * Reconstitute a valid CFB (Compound Binary File) from a flat list of
 * {@link MSGBurnerEntry} descriptors — root storage at index 0, its
 * children reachable through `children` indices.
 *
 * @remarks
 * Builds a red-black directory tree, allocates FAT/mini-FAT/DIFAT
 * sectors, then writes the header, directory entries, and stream data
 * into a single binary. Used to extract embedded `.msg` attachments as
 * standalone CFB files.
 *
 * @param entries - Flat entry list starting with Root Entry at index 0
 * @returns Complete CFB binary as Uint8Array
 * @throws {@link MSGError} with code `BURN` when an entry name exceeds
 * the {@link MSG_BURNER_NAME_MAX} UTF-16 code unit limit the CFB directory entry format allows
 */
export function burnCFB(entries: readonly MSGBurnerEntry[]): Uint8Array {
	const liteEntries: MSGBurnerLiteEntry[] = entries.map((entry) => ({
		entry,
		left: -1,
		right: -1,
		child: -1,
		firstSector: 0,
		mini: entry.type === MSG_TYPE_DOCUMENT && entry.length < MSG_BURNER_MINI_STREAM_CUTOFF,
		red: false,
	}))
	const fat: number[] = []
	const miniFat: number[] = []

	const allocateFat = (count: number): number => {
		const first = fat.length
		for (let i = 0; i < count; i++) {
			const next = i + 1 === count ? MSG_END_OF_CHAIN : first + i + 1
			fat.push(next)
		}
		return first
	}

	const allocateFatAs = (count: number, value: number): number => {
		const first = fat.length
		for (let i = 0; i < count; i++) {
			fat.push(value)
		}
		return first
	}

	const allocateMiniFat = (count: number): number => {
		const first = miniFat.length
		for (let i = 0; i < count; i++) {
			const next = i + 1 === count ? MSG_END_OF_CHAIN : first + i + 1
			miniFat.push(next)
		}
		return first
	}

	function buildTree(dirIndex: number): void {
		const liteEntry = liteEntries[dirIndex]
		const children = liteEntry.entry.children
		if (children === undefined || children.length === 0) return

		const sorted = children
			.slice()
			.sort((a, b) => compareCFBName(liteEntries[a].entry.name, liteEntries[b].entry.name))

		const mid = Math.floor(sorted.length / 2)
		const rootIndex = sorted[mid]
		const rootEntry = liteEntries[rootIndex]
		rootEntry.red = false
		rootEntry.left = splitTree(sorted, 0, mid, true)
		rootEntry.right = splitTree(sorted, mid + 1, sorted.length, true)
		liteEntry.child = rootIndex

		for (let i = 0; i < sorted.length; i++) {
			const idx = sorted[i]
			if (liteEntries[idx].entry.type === MSG_TYPE_DIRECTORY) {
				buildTree(idx)
			}
		}
	}

	function splitTree(sorted: number[], start: number, end: number, red: boolean): number {
		if (start >= end) return -1
		const mid = Math.floor((start + end) / 2)
		const entryIndex = sorted[mid]
		const entry = liteEntries[entryIndex]
		entry.red = red
		entry.left = splitTree(sorted, start, mid, !red)
		entry.right = splitTree(sorted, mid + 1, end, !red)
		return entryIndex
	}

	function buildDifat(
		difat1: number[],
		difat2: number[],
		numFatSectors: number,
		firstFatSector: number,
		firstDifatSector: number,
	): void {
		let x = 0
		for (; x < MSG_BURNER_DIFAT_HEADER_SLOTS && x < numFatSectors; x++) {
			difat1.push(firstFatSector + x)
		}
		let nextDifatSector = firstDifatSector + 1
		for (; x < numFatSectors; x++) {
			difat2.push(firstFatSector + x)
			if ((difat2.length & 127) === 127) {
				difat2.push(nextDifatSector)
				nextDifatSector++
			}
		}
		while (difat2.length > 0 && (difat2.length & 127) !== 0) {
			const remain = difat2.length & 127
			difat2.push(remain === 127 ? MSG_END_OF_CHAIN : MSG_UNUSED_BLOCK)
		}
	}

	function writeHeader(
		view: DataView,
		bytes: Uint8Array,
		numFatSectors: number,
		entriesFirstSector: number,
		firstMiniFatSector: number,
		numMiniFatSectors: number,
		firstDifatSector: number,
		numDifatSectors: number,
		difat1: number[],
	): void {
		bytes.set(MSG_FILE_HEADER, 0)
		view.setUint16(0x18, 0x3e, true)
		view.setUint16(0x1a, 0x03, true)
		view.setUint16(0x1c, 0xfffe, true)
		view.setUint16(0x1e, 9, true)
		view.setUint16(0x20, 6, true)

		view.setInt32(0x2c, numFatSectors, true)
		view.setInt32(0x30, entriesFirstSector, true)

		view.setInt32(0x38, MSG_BURNER_MINI_STREAM_CUTOFF, true)
		view.setInt32(0x3c, firstMiniFatSector, true)
		view.setInt32(0x40, numMiniFatSectors, true)
		view.setInt32(0x44, firstDifatSector, true)
		view.setInt32(0x48, numDifatSectors, true)

		let offset = 0x4c
		for (let i = 0; i < difat1.length; i++) {
			view.setInt32(offset, difat1[i], true)
			offset += 4
		}
		for (let i = difat1.length; i < MSG_BURNER_DIFAT_HEADER_SLOTS; i++) {
			view.setInt32(offset, MSG_UNUSED_BLOCK, true)
			offset += 4
		}
	}

	function writeDirectoryEntries(
		view: DataView,
		bytes: Uint8Array,
		entriesFirstSector: number,
		bytesMiniFat: number,
	): void {
		for (let x = 0; x < liteEntries.length; x++) {
			const le = liteEntries[x]
			const pos = MSG_BURNER_SECTOR_SIZE * (1 + entriesFirstSector) + MSG_BURNER_DIR_ENTRY_SIZE * x

			// CFB caps a directory entry name at MSG_BURNER_NAME_MAX UTF-16 code
			// units + a NUL terminator inside the fixed 64-byte name field
			// (offsets 0x00-0x3f). A longer name would overrun into the
			// type/color/sibling fields that follow, so validate before
			// writing any name bytes.
			const name = le.entry.name
			if (name.length > MSG_BURNER_NAME_MAX) {
				throw new MSGError(
					'BURN',
					`directory entry name exceeds ${MSG_BURNER_NAME_MAX} characters`,
					{
						name,
					},
				)
			}

			for (let i = 0; i < name.length; i++) {
				view.setUint16(pos + i * 2, name.charCodeAt(i), true)
			}
			// NUL terminator + recorded byte length: (chars + 1) UTF-16 units.
			view.setUint16(pos + name.length * 2, 0, true)

			view.setUint16(pos + 0x40, (name.length + 1) * 2, true)
			bytes[pos + 0x42] = le.entry.type
			bytes[pos + 0x43] = le.red ? 0 : 1
			view.setInt32(pos + 0x44, le.left, true)
			view.setInt32(pos + 0x48, le.right, true)
			view.setInt32(pos + 0x4c, le.child, true)

			if (x === 0) {
				bytes.set(MSG_BURNER_ROOT_CLSID, pos + 0x50)
			}

			const length = x === 0 ? bytesMiniFat : le.entry.length
			const firstSector =
				length !== 0 ? le.firstSector : le.entry.type === MSG_TYPE_DIRECTORY ? 0 : MSG_END_OF_CHAIN

			view.setInt32(pos + 0x74, firstSector, true)
			view.setInt32(pos + 0x78, length, true)
		}
	}

	function writeLargeStreams(bytes: Uint8Array): void {
		for (let i = 0; i < liteEntries.length; i++) {
			const le = liteEntries[i]
			if (
				le.entry.type === MSG_TYPE_DOCUMENT &&
				!le.mini &&
				le.entry.binaryProvider !== undefined
			) {
				const data = le.entry.binaryProvider()
				bytes.set(data, MSG_BURNER_SECTOR_SIZE * (1 + le.firstSector))
			}
		}
	}

	function writeMiniStreams(bytes: Uint8Array, firstMiniDataSector: number): void {
		if (firstMiniDataSector === MSG_END_OF_CHAIN) return

		for (let i = 0; i < liteEntries.length; i++) {
			const le = liteEntries[i]
			if (le.entry.type === MSG_TYPE_DOCUMENT && le.mini && le.entry.binaryProvider !== undefined) {
				const data = le.entry.binaryProvider()
				bytes.set(
					data,
					MSG_BURNER_SECTOR_SIZE * (1 + firstMiniDataSector) +
						MSG_BURNER_MINI_SECTOR_SIZE * le.firstSector,
				)
			}
		}
	}

	function writeMiniFat(view: DataView, firstMiniFatSector: number): void {
		if (firstMiniFatSector === MSG_END_OF_CHAIN) return

		let offset = MSG_BURNER_SECTOR_SIZE * (1 + firstMiniFatSector)
		for (let i = 0; i < miniFat.length; i++) {
			view.setInt32(offset, miniFat[i], true)
			offset += 4
		}
	}

	function writeFat(view: DataView, firstFatSector: number): void {
		while (fat.length % MSG_BURNER_INTS_PER_SECTOR !== 0) {
			fat.push(MSG_UNUSED_BLOCK)
		}

		let offset = MSG_BURNER_SECTOR_SIZE * (1 + firstFatSector)
		for (let i = 0; i < fat.length; i++) {
			view.setInt32(offset, fat[i], true)
			offset += 4
		}
	}

	function writeDifat(
		view: DataView,
		difat2: number[],
		firstDifatSector: number,
		numDifatSectors: number,
	): void {
		if (numDifatSectors < 1) return

		let offset = MSG_BURNER_SECTOR_SIZE * (1 + firstDifatSector)
		for (let i = 0; i < difat2.length; i++) {
			view.setInt32(offset, difat2[i], true)
			offset += 4
		}
	}

	buildTree(0)

	// Allocate directory sectors
	const dirSectorCount = sectorsNeeded(
		MSG_BURNER_DIR_ENTRY_SIZE * liteEntries.length,
		MSG_BURNER_SECTOR_SIZE,
	)
	const entriesFirstSector = allocateFat(dirSectorCount)

	// Allocate large document streams
	for (let i = 0; i < liteEntries.length; i++) {
		const le = liteEntries[i]
		if (le.entry.type === MSG_TYPE_DOCUMENT && !le.mini) {
			le.firstSector =
				le.entry.length === 0
					? MSG_END_OF_CHAIN
					: allocateFat(sectorsNeeded(le.entry.length, MSG_BURNER_SECTOR_SIZE))
		}
	}

	// Allocate mini-stream document streams
	for (let i = 0; i < liteEntries.length; i++) {
		const le = liteEntries[i]
		if (le.entry.type === MSG_TYPE_DOCUMENT && le.mini) {
			le.firstSector =
				le.entry.length === 0
					? MSG_END_OF_CHAIN
					: allocateMiniFat(sectorsNeeded(le.entry.length, MSG_BURNER_MINI_SECTOR_SIZE))
		}
	}

	// Allocate mini-FAT sectors
	const numMiniFatSectors = sectorsNeeded(4 * miniFat.length, MSG_BURNER_SECTOR_SIZE)
	const firstMiniFatSector =
		numMiniFatSectors !== 0 ? allocateFat(numMiniFatSectors) : MSG_END_OF_CHAIN

	// Allocate mini-stream data sectors (root entry body)
	const bytesMiniFat = MSG_BURNER_MINI_SECTOR_SIZE * miniFat.length
	const firstMiniDataSector =
		bytesMiniFat > 0
			? allocateFat(sectorsNeeded(bytesMiniFat, MSG_BURNER_SECTOR_SIZE))
			: MSG_END_OF_CHAIN

	liteEntries[0].firstSector =
		firstMiniDataSector === MSG_END_OF_CHAIN ? MSG_END_OF_CHAIN : firstMiniDataSector

	// Allocate FAT sectors (self-referencing)
	const estimatedFatSectors = Math.max(
		1,
		sectorsNeeded(
			4 * (fat.length + Math.ceil(fat.length / MSG_BURNER_INTS_PER_SECTOR) + 1),
			MSG_BURNER_SECTOR_SIZE,
		),
	)
	const firstFatSector = allocateFatAs(estimatedFatSectors, MSG_BURNER_FAT_SECTOR_MARKER)
	const numFatSectors = fat.length - firstFatSector

	// Allocate DIFAT sectors
	const numDifatSectors =
		numFatSectors > MSG_BURNER_DIFAT_HEADER_SLOTS
			? sectorsNeeded(
					4 * Math.ceil(((numFatSectors - MSG_BURNER_DIFAT_HEADER_SLOTS) / 127) * 128),
					MSG_BURNER_SECTOR_SIZE,
				)
			: 0
	const firstDifatSector =
		numDifatSectors !== 0
			? allocateFatAs(numDifatSectors, MSG_BURNER_DIFAT_SECTOR_MARKER)
			: MSG_END_OF_CHAIN

	// Build the binary
	const totalSize = MSG_BURNER_SECTOR_SIZE * (1 + fat.length)
	const buffer = new ArrayBuffer(totalSize)
	const view = new DataView(buffer)
	const bytes = new Uint8Array(buffer)

	// Pad mini-FAT to sector boundary
	while (miniFat.length % MSG_BURNER_INTS_PER_SECTOR !== 0) {
		miniFat.push(MSG_UNUSED_BLOCK)
	}

	// Build DIFAT arrays
	const difat1: number[] = []
	const difat2: number[] = []
	buildDifat(difat1, difat2, numFatSectors, firstFatSector, firstDifatSector)

	writeHeader(
		view,
		bytes,
		numFatSectors,
		entriesFirstSector,
		firstMiniFatSector,
		numMiniFatSectors,
		firstDifatSector,
		numDifatSectors,
		difat1,
	)
	writeDirectoryEntries(view, bytes, entriesFirstSector, bytesMiniFat)
	writeLargeStreams(bytes)
	writeMiniStreams(bytes, firstMiniDataSector)
	writeMiniFat(view, firstMiniFatSector)
	writeFat(view, firstFatSector)
	writeDifat(view, difat2, firstDifatSector, numDifatSectors)

	return new Uint8Array(buffer)
}
