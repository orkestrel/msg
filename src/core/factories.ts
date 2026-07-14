import type {
	MsgReaderInterface,
	MsgReaderOptions,
	MsgBurnerInterface,
	EmailParserInterface,
	EmailParserOptions,
} from './types.js'
import { MsgReader } from './MsgReader.js'
import { MsgBurner } from './MsgBurner.js'
import { EmailParser } from './EmailParser.js'

// === MsgReader

/**
 * Create a new .msg file reader.
 *
 * @param buffer - Raw .msg file bytes
 * @param options - Optional reader configuration
 * @returns A working {@link MsgReaderInterface}
 *
 * @example
 * ```ts
 * import { createMsgReader } from '@src/core'
 *
 * const reader = createMsgReader(buffer)
 * const data = reader.parse()
 * console.log(data.kind)
 * ```
 */
export function createMsgReader(
	buffer: ArrayBuffer | Uint8Array,
	options?: MsgReaderOptions,
): MsgReaderInterface {
	return new MsgReader(buffer, options)
}

// === MsgBurner

/**
 * Create a new CFB binary writer for reconstituting .msg files.
 *
 * @returns A working {@link MsgBurnerInterface}
 *
 * @example
 * ```ts
 * import { createMsgBurner } from '@src/core'
 *
 * const burner = createMsgBurner()
 * const binary = burner.burn(entries)
 * ```
 */
export function createMsgBurner(): MsgBurnerInterface {
	return new MsgBurner()
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
