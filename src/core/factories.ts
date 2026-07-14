import type {
	MSGReaderInterface,
	MSGReaderOptions,
	MSGBurnerInterface,
	EmailParserInterface,
	EmailParserOptions,
} from './types.js'
import { MSGReader } from './MSGReader.js'
import { MSGBurner } from './MSGBurner.js'
import { EmailParser } from './EmailParser.js'

// === MSGReader

/**
 * Create a new .msg file reader.
 *
 * @param buffer - Raw .msg file bytes
 * @param options - Optional reader configuration
 * @returns A working {@link MSGReaderInterface}
 *
 * @example
 * ```ts
 * import { createMSGReader } from '@src/core'
 *
 * const reader = createMSGReader(buffer)
 * const data = reader.parse()
 * console.log(data.kind)
 * ```
 */
export function createMSGReader(
	buffer: ArrayBuffer | Uint8Array,
	options?: MSGReaderOptions,
): MSGReaderInterface {
	return new MSGReader(buffer, options)
}

// === MSGBurner

/**
 * Create a new CFB binary writer for reconstituting .msg files.
 *
 * @returns A working {@link MSGBurnerInterface}
 *
 * @example
 * ```ts
 * import { createMSGBurner } from '@src/core'
 *
 * const burner = createMSGBurner()
 * const binary = burner.burn(entries)
 * ```
 */
export function createMSGBurner(): MSGBurnerInterface {
	return new MSGBurner()
}

// === EmailParser

/**
 * Create a new email file parser for .eml and .msg input.
 *
 * @param options - Optional parser configuration
 * @returns A working {@link EmailParserInterface}
 *
 * @example
 * ```ts
 * import { createEmailParser, isSuccess } from '@src/core'
 *
 * const parser = createEmailParser()
 * const result = parser.parse({ bytes, name: 'message.eml' })
 * if (isSuccess(result)) {
 * 	console.log(result.value.messages[0].subject)
 * }
 * ```
 */
export function createEmailParser(options?: EmailParserOptions): EmailParserInterface {
	return new EmailParser(options)
}
