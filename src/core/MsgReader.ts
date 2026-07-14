/**
 * MsgReader
 *
 * Parses Microsoft Outlook .msg files (CFB/OLE2 compound binary format).
 * Extracts message fields, recipients, and attachments using native
 * DataView operations with no external dependencies.
 */

import type {
	MsgReaderInterface,
	MsgReaderOptions,
	MsgFieldData,
	MsgAttachment,
	MsgRecipientRole,
	MsgDirectoryEntry,
	MsgMutableFieldData,
	MsgNameIdEntry,
	MsgBurnerEntry,
} from './types.js'
import { MsgError } from './errors.js'
import {
	MSG_END_OF_CHAIN,
	MSG_UNUSED_BLOCK,
	MSG_S_BIG_BLOCK_SIZE,
	MSG_L_BIG_BLOCK_SIZE,
	MSG_L_BIG_BLOCK_MARK,
	MSG_SMALL_BLOCK_SIZE,
	MSG_BIG_BLOCK_MIN_DOC_SIZE,
	MSG_HEADER_PROPERTY_START_OFFSET,
	MSG_HEADER_BAT_START_OFFSET,
	MSG_HEADER_BAT_COUNT_OFFSET,
	MSG_HEADER_SBAT_START_OFFSET,
	MSG_HEADER_SBAT_COUNT_OFFSET,
	MSG_HEADER_XBAT_START_OFFSET,
	MSG_HEADER_XBAT_COUNT_OFFSET,
	MSG_PROP_NO_INDEX,
	MSG_PROPERTY_SIZE,
	MSG_PROP_NAME_SIZE_OFFSET,
	MSG_PROP_TYPE_OFFSET,
	MSG_PROP_PREVIOUS_PROPERTY_OFFSET,
	MSG_PROP_NEXT_PROPERTY_OFFSET,
	MSG_PROP_CHILD_PROPERTY_OFFSET,
	MSG_PROP_START_BLOCK_OFFSET,
	MSG_PROP_SIZE_OFFSET,
	MSG_TYPE_DIRECTORY,
	MSG_TYPE_DOCUMENT,
	MSG_TYPE_ROOT,
	MSG_PREFIX_ATTACHMENT,
	MSG_PREFIX_RECIPIENT,
	MSG_PREFIX_DOCUMENT,
	MSG_PREFIX_NAMEID,
	MSG_FIELD_NAME_MAPPING,
	MSG_FIELD_FULL_NAME_MAPPING,
	MSG_FIELD_TYPE_MAPPING,
	MSG_FIELD_CLASS_ATTACHMENT_DATA,
	MSG_FIELD_DIR_TYPE_INNER_MSG,
	MSG_PIDLID_MAPPING,
	MSG_MAPI_RECIPIENT_TO,
	MSG_MAPI_RECIPIENT_CC,
	MSG_MAPI_RECIPIENT_BCC,
	MSG_BURNER_NAME_MAX,
	MSG_MAX_HIERARCHY_DEPTH,
} from './constants.js'
import {
	isMsgFile,
	removeTrailingNull,
	readUtf16String,
	readAnsiString,
	fileTimeToUtcString,
	toHexLower,
	msftUuidStringify,
} from './helpers.js'
import { MsgBurner } from './MsgBurner.js'
// === MsgReader

/**
 * Parses Microsoft Outlook .msg files (CFB/OLE2 compound binary format).
 * Every parsing step treats the input as untrusted: sector and property
 * chains are cycle-guarded and length-capped, every raw byte range is
 * bounds-checked before a view is constructed over it, and every failure
 * surfaces as a typed {@link MsgError} rather than a raw `RangeError` or
 * `TypeError`.
 */
export class MsgReader implements MsgReaderInterface {
	readonly #view: DataView
	readonly #byteLength: number
	readonly #totalSectors: number
	readonly #options: MsgReaderOptions
	#bigBlockSize = 0
	#bigBlockLength = 0
	#xBlockLength = 0
	#batCount = 0
	#propertyStart = 0
	#sbatStart = 0
	#sbatCount = 0
	#xbatStart = 0
	#xbatCount = 0
	#bat: number[] = []
	#sbat: number[] = []
	#properties: MsgDirectoryEntry[] = []
	#bigBlockTable: number[] = []
	#fields: MsgFieldData | undefined
	#privatePidToKeyed: Record<number, MsgNameIdEntry> = {}
	#innerMsgBurners: Record<number, () => Uint8Array> = {}

	/**
	 * Create a reader over a raw MSG file buffer.
	 *
	 * @param input - Raw MSG file bytes, as an `ArrayBuffer` or a `Uint8Array` view
	 * @param options - Reader configuration
	 */
	constructor(input: ArrayBuffer | Uint8Array, options?: MsgReaderOptions) {
		if (input instanceof Uint8Array) {
			this.#view = new DataView(input.buffer, input.byteOffset, input.byteLength)
			this.#byteLength = input.byteLength
		} else {
			this.#view = new DataView(input)
			this.#byteLength = input.byteLength
		}
		this.#options = options ?? {}
		this.#totalSectors = Math.ceil(this.#byteLength / MSG_S_BIG_BLOCK_SIZE)
	}

	/**
	 * Parse the MSG file and return extracted field data.
	 *
	 * @returns Root message field data with nested attachments and recipients
	 * @throws {@link MsgError} with code `UNSUPPORTED`, `MALFORMED`, `CYCLE`,
	 * or `RANGE` when the compound file cannot be parsed
	 */
	parse(): MsgFieldData {
		if (this.#fields !== undefined) return this.#fields

		this.#parseHeader()
		this.#bat = this.#readBat()
		if (this.#xbatCount > 0) {
			this.#readXbat()
		}
		this.#sbat = this.#readSbat()
		this.#properties = this.#readProperties(this.#propertyStart)
		this.#bigBlockTable = this.#buildBigBlockTable()
		this.#privatePidToKeyed = {}
		this.#innerMsgBurners = {}

		const fields = this.#extractFields()
		this.#fields = fields
		return fields
	}

	/**
	 * Read attachment binary content by index.
	 *
	 * @param index - Zero-based index into the parsed attachment list
	 * @returns File name and raw binary content
	 * @throws {@link MsgError} with code `RANGE` when the index is out of bounds
	 */
	attachment(index: number): MsgAttachment {
		const parsed = this.parse()
		const attachments = parsed.attachments
		if (attachments === undefined || index < 0 || index >= attachments.length) {
			throw new MsgError('RANGE', `Attachment index ${index} out of range`, { index })
		}

		const attach = attachments[index]
		if (attach.innerMsgContent === true && typeof attach.folderId === 'number') {
			const name = typeof attach.name === 'string' ? attach.name : 'embedded'
			const burner = this.#innerMsgBurners[attach.folderId]
			const content = burner !== undefined ? burner() : new Uint8Array(0)
			return { fileName: name + '.msg', content }
		}

		if (
			typeof attach.dataId !== 'number' ||
			attach.dataId < 0 ||
			attach.dataId >= this.#properties.length
		) {
			throw new MsgError('RANGE', 'Attachment has no valid data reference', { index })
		}

		const entry = this.#properties[attach.dataId]
		const content = this.#readEntry(entry)
		const fileName =
			typeof attach.fileName === 'string'
				? attach.fileName
				: typeof attach.fileNameShort === 'string'
					? attach.fileNameShort
					: typeof attach.name === 'string'
						? attach.name
						: 'unknown'

		return { fileName, content }
	}

	/**
	 * Rebuild the parsed MSG as a standalone CFB/.msg binary.
	 *
	 * @returns Complete CFB byte stream
	 * @throws {@link MsgError} with code `BURN` when the parsed structure
	 * cannot be reconstituted
	 */
	burn(): Uint8Array {
		const parsed = this.parse()
		if (parsed.kind !== 'msg') {
			throw new MsgError('BURN', 'Unable to burn a non-message field data structure', {
				kind: parsed.kind,
			})
		}

		const root = this.#properties[0]
		if (root === undefined) {
			throw new MsgError('BURN', 'Unable to burn MSG file without a root entry')
		}

		return this.#burnFolder(root, false, false)
	}

	// === Header Parsing

	#parseHeader(): void {
		if (!isMsgFile(this.#view)) {
			throw new MsgError('UNSUPPORTED', 'Input is not a recognized CFB/MSG file')
		}
		if (this.#byteLength < MSG_S_BIG_BLOCK_SIZE) {
			throw new MsgError('MALFORMED', 'File is smaller than the minimum CFB header size', {
				byteLength: this.#byteLength,
			})
		}

		const v = this.#view
		const sectorMark = v.getUint8(30)
		this.#bigBlockSize =
			sectorMark === MSG_L_BIG_BLOCK_MARK ? MSG_L_BIG_BLOCK_SIZE : MSG_S_BIG_BLOCK_SIZE
		this.#bigBlockLength = this.#bigBlockSize / 4
		this.#xBlockLength = this.#bigBlockLength - 1

		const batCount = v.getInt32(MSG_HEADER_BAT_COUNT_OFFSET, true)
		const propertyStart = v.getInt32(MSG_HEADER_PROPERTY_START_OFFSET, true)
		const sbatStart = v.getInt32(MSG_HEADER_SBAT_START_OFFSET, true)
		const sbatCount = v.getInt32(MSG_HEADER_SBAT_COUNT_OFFSET, true)
		const xbatStart = v.getInt32(MSG_HEADER_XBAT_START_OFFSET, true)
		const xbatCount = v.getInt32(MSG_HEADER_XBAT_COUNT_OFFSET, true)

		this.#validateHeaderField('batCount', batCount)
		this.#validateHeaderField('sbatCount', sbatCount)
		this.#validateHeaderField('xbatCount', xbatCount)
		this.#validateHeaderField('propertyStart', propertyStart)

		this.#batCount = batCount
		this.#propertyStart = propertyStart
		this.#sbatStart = sbatStart
		this.#sbatCount = sbatCount
		this.#xbatStart = xbatStart
		this.#xbatCount = xbatCount
	}

	// two words: validates a single header count/sector field against totalSectors
	#validateHeaderField(name: string, value: number): void {
		if (value < 0 || value > this.#totalSectors) {
			throw new MsgError('MALFORMED', `CFB header field '${name}' is out of range`, {
				field: name,
				value,
			})
		}
	}

	// bounds guard shared by every raw byte-range read over the file view
	#assertBounds(start: number, length: number): void {
		if (start < 0 || length < 0 || start + length > this.#byteLength) {
			throw new MsgError('MALFORMED', 'Computed byte range exceeds file bounds', {
				start,
				length,
				byteLength: this.#byteLength,
			})
		}
	}

	// cycle guard shared by every sector-chain walk; each domain supplies its
	// own capacity (big-sector chains cap at totalSectors, the small-block
	// chain caps at the mini-FAT's own capacity) so a mini-stream chain -
	// which routinely has far more links than the file has big sectors - is
	// never conflated with a big-sector chain's cap
	#trackSector(
		visited: Set<number>,
		sector: number,
		label: string,
		limit: number,
		capacityLabel: string,
	): void {
		if (visited.has(sector)) {
			throw new MsgError('CYCLE', `${label} chain revisits sector ${sector}`, { sector })
		}
		if (visited.size >= limit) {
			throw new MsgError('CYCLE', `${label} chain exceeds ${capacityLabel}`, {
				limit,
			})
		}
		visited.add(sector)
	}

	// === FAT (Block Allocation Table)

	#batCountInHeader(): number {
		const max = (MSG_S_BIG_BLOCK_SIZE - MSG_HEADER_BAT_START_OFFSET) / 4
		return Math.min(this.#batCount, max)
	}

	#readBat(): number[] {
		const count = this.#batCountInHeader()
		const result: number[] = new Array(count)
		let offset = MSG_HEADER_BAT_START_OFFSET
		for (let i = 0; i < count; i++) {
			result[i] = this.#view.getInt32(offset, true)
			offset += 4
		}
		return result
	}

	#blockOffset(sector: number): number {
		if (sector < 0 || sector >= this.#totalSectors) {
			throw new MsgError('MALFORMED', `Sector index out of range: ${sector}`, {
				sector,
				totalSectors: this.#totalSectors,
			})
		}
		return (sector + 1) * this.#bigBlockSize
	}

	#blockValueAt(sector: number, index: number): number {
		const offset = this.#blockOffset(sector) + 4 * index
		this.#assertBounds(offset, 4)
		return this.#view.getInt32(offset, true)
	}

	#nextBlockInner(offset: number, table: number[]): number {
		const block = Math.floor(offset / this.#bigBlockLength)
		const index = offset % this.#bigBlockLength
		const sector = table[block]
		if (sector === undefined) return MSG_END_OF_CHAIN
		return this.#blockValueAt(sector, index)
	}

	#nextBlock(offset: number): number {
		return this.#nextBlockInner(offset, this.#bat)
	}

	#nextBlockSmall(offset: number): number {
		return this.#nextBlockInner(offset, this.#sbat)
	}

	// === SBAT (Small Block Allocation Table)

	#readSbat(): number[] {
		const result: number[] = []
		const visited = new Set<number>()
		let startIndex = this.#sbatStart
		for (
			let i = 0;
			i < this.#sbatCount && startIndex !== 0 && startIndex !== MSG_END_OF_CHAIN;
			i++
		) {
			this.#trackSector(visited, startIndex, 'SBAT', this.#totalSectors, 'total sector count')
			result.push(startIndex)
			startIndex = this.#nextBlock(startIndex)
		}
		return result
	}

	// === XBAT (Extended BAT / DIFAT)

	#readXbat(): void {
		const headerBatCount = this.#batCountInHeader()
		let remaining = this.#batCount - headerBatCount
		let nextSector = this.#xbatStart
		const visited = new Set<number>()

		for (let i = 0; i < this.#xbatCount; i++) {
			this.#trackSector(visited, nextSector, 'XBAT', this.#totalSectors, 'total sector count')
			const blockOffset = this.#blockOffset(nextSector)
			this.#assertBounds(blockOffset, this.#bigBlockSize)
			const toProcess = Math.min(remaining, this.#xBlockLength)

			for (let j = 0; j < toProcess; j++) {
				const sector = this.#view.getInt32(blockOffset + j * 4, true)
				if (sector === MSG_UNUSED_BLOCK || sector === MSG_END_OF_CHAIN) break
				this.#bat.push(sector)
			}
			remaining -= toProcess

			nextSector = this.#view.getInt32(blockOffset + this.#xBlockLength * 4, true)
			if (nextSector === MSG_UNUSED_BLOCK || nextSector === MSG_END_OF_CHAIN) break
		}
	}

	// === Directory Entry Parsing

	#readEntryName(offset: number): string {
		const nameBytes = this.#view.getUint16(offset + MSG_PROP_NAME_SIZE_OFFSET, true)
		if (nameBytes < 2) return ''
		// The fixed 64-byte CFB name field holds at most 32 UTF-16 units
		// including the NUL terminator, so a hostile name-size field is
		// clamped to that field's own capacity before it is ever read.
		const charCount = Math.min(nameBytes / 2 - 1, MSG_BURNER_NAME_MAX)
		return removeTrailingNull(readUtf16String(this.#view, offset, charCount))
	}

	#readDirectoryEntry(offset: number): MsgDirectoryEntry {
		const v = this.#view
		return {
			type: v.getUint8(offset + MSG_PROP_TYPE_OFFSET),
			name: this.#readEntryName(offset),
			previousProperty: v.getInt32(offset + MSG_PROP_PREVIOUS_PROPERTY_OFFSET, true),
			nextProperty: v.getInt32(offset + MSG_PROP_NEXT_PROPERTY_OFFSET, true),
			childProperty: v.getInt32(offset + MSG_PROP_CHILD_PROPERTY_OFFSET, true),
			startBlock: v.getInt32(offset + MSG_PROP_START_BLOCK_OFFSET, true),
			sizeBlock: v.getInt32(offset + MSG_PROP_SIZE_OFFSET, true),
		}
	}

	#readProperties(propertyStart: number): MsgDirectoryEntry[] {
		const props: MsgDirectoryEntry[] = []
		const visited = new Set<number>()
		let currentSector = propertyStart

		while (currentSector !== MSG_END_OF_CHAIN) {
			this.#trackSector(
				visited,
				currentSector,
				'Property',
				this.#totalSectors,
				'total sector count',
			)
			const entryCount = this.#bigBlockSize / MSG_PROPERTY_SIZE
			let offset = this.#blockOffset(currentSector)

			for (let i = 0; i < entryCount; i++) {
				if (offset + MSG_PROPERTY_SIZE > this.#byteLength) break
				const entryType = this.#view.getUint8(offset + MSG_PROP_TYPE_OFFSET)

				if (
					entryType === MSG_TYPE_ROOT ||
					entryType === MSG_TYPE_DIRECTORY ||
					entryType === MSG_TYPE_DOCUMENT
				) {
					props.push(this.#readDirectoryEntry(offset))
				} else {
					props.push({
						type: entryType,
						name: '',
						previousProperty: -1,
						nextProperty: -1,
						childProperty: -1,
						startBlock: 0,
						sizeBlock: 0,
					})
				}
				offset += MSG_PROPERTY_SIZE
			}
			currentSector = this.#nextBlock(currentSector)
		}

		if (props.length > 0) {
			this.#buildHierarchy(props, 0, new Set<number>(), 0)
		}
		return props
	}

	#buildHierarchy(
		props: MsgDirectoryEntry[],
		nodeIndex: number,
		visited: Set<number>,
		depth: number,
	): void {
		const node = props[nodeIndex]
		if (node === undefined || node.childProperty === MSG_PROP_NO_INDEX) return

		if (depth > MSG_MAX_HIERARCHY_DEPTH) {
			throw new MsgError('CYCLE', 'Directory hierarchy nesting exceeds maximum depth', {
				depth,
				max: MSG_MAX_HIERARCHY_DEPTH,
			})
		}
		if (visited.has(nodeIndex)) {
			throw new MsgError('CYCLE', `Directory hierarchy revisits property index ${nodeIndex}`, {
				index: nodeIndex,
			})
		}
		if (visited.size >= props.length) {
			throw new MsgError('CYCLE', 'Directory hierarchy traversal exceeds total property count', {
				limit: props.length,
			})
		}
		visited.add(nodeIndex)
		node.children = []

		const siblingVisited = new Set<number>([node.childProperty])
		const stack: Array<{ mode: string; index: number }> = [
			{ mode: 'walk', index: node.childProperty },
		]

		while (stack.length > 0) {
			const item = stack.pop()
			if (item === undefined) break
			const current = props[item.index]
			if (current === undefined) continue

			if (item.mode === 'push') {
				node.children.push(item.index)
			} else {
				if (current.type === MSG_TYPE_DIRECTORY) {
					this.#buildHierarchy(props, item.index, visited, depth + 1)
				}
				if (current.nextProperty !== MSG_PROP_NO_INDEX) {
					if (siblingVisited.has(current.nextProperty)) {
						throw new MsgError(
							'CYCLE',
							`Directory sibling chain revisits property index ${current.nextProperty}`,
							{ index: current.nextProperty },
						)
					}
					siblingVisited.add(current.nextProperty)
					stack.push({ mode: 'walk', index: current.nextProperty })
				}
				stack.push({ mode: 'push', index: item.index })
				if (current.previousProperty !== MSG_PROP_NO_INDEX) {
					if (siblingVisited.has(current.previousProperty)) {
						throw new MsgError(
							'CYCLE',
							`Directory sibling chain revisits property index ${current.previousProperty}`,
							{ index: current.previousProperty },
						)
					}
					siblingVisited.add(current.previousProperty)
					stack.push({ mode: 'walk', index: current.previousProperty })
				}
			}
		}
	}

	// === Big Block Table (mini-stream container chain)

	#buildBigBlockTable(): number[] {
		const rootProp = this.#properties[0]
		if (rootProp === undefined) return []

		const table: number[] = []
		const visited = new Set<number>()
		let nextBlock = rootProp.startBlock
		while (nextBlock !== MSG_END_OF_CHAIN) {
			this.#trackSector(visited, nextBlock, 'Big block', this.#totalSectors, 'total sector count')
			table.push(nextBlock)
			nextBlock = this.#nextBlock(nextBlock)
		}
		return table
	}

	// === Data Reading

	#readSmallBlockData(
		startBlock: number,
		blockSize: number,
		dest: Uint8Array,
		destOffset: number,
	): void {
		const byteOffset = startBlock * MSG_SMALL_BLOCK_SIZE
		const bigBlockNumber = Math.floor(byteOffset / this.#bigBlockSize)
		const bigBlockOffset = byteOffset % this.#bigBlockSize

		const sector = this.#bigBlockTable[bigBlockNumber]
		if (sector === undefined) return
		const start = this.#blockOffset(sector) + bigBlockOffset
		this.#assertBounds(start, blockSize)
		const src = new Uint8Array(this.#view.buffer, this.#view.byteOffset + start, blockSize)
		dest.set(src, destOffset)
	}

	#readSmallChainData(entry: MsgDirectoryEntry, chain: number[]): Uint8Array {
		const result = new Uint8Array(entry.sizeBlock)
		let idx = 0
		for (let i = 0; i < chain.length; i++) {
			const readLen = Math.min(result.length - idx, MSG_SMALL_BLOCK_SIZE)
			this.#readSmallBlockData(chain[i], readLen, result, idx)
			idx += readLen
		}
		return result
	}

	#smallBlockChain(entry: MsgDirectoryEntry): number[] {
		const chain: number[] = []
		const visited = new Set<number>()
		// the mini-FAT lives in this.#sbat's big sectors, each holding
		// bigBlockLength int32 entries - that flat entry count, not the
		// file's big-sector count, bounds a legitimate mini-stream chain
		const capacity = this.#sbat.length * this.#bigBlockLength
		let next = entry.startBlock
		while (next !== MSG_END_OF_CHAIN) {
			if (next < 0 || next >= capacity) {
				throw new MsgError('MALFORMED', `Small block index ${next} exceeds mini-FAT capacity`, {
					sector: next,
					capacity,
				})
			}
			this.#trackSector(visited, next, 'Small block', capacity, 'mini-FAT capacity')
			chain.push(next)
			next = this.#nextBlockSmall(next)
		}
		return chain
	}

	#readEntry(entry: MsgDirectoryEntry): Uint8Array {
		if (entry.sizeBlock <= 0) return new Uint8Array(0)
		if (entry.sizeBlock > this.#byteLength) {
			throw new MsgError('MALFORMED', 'Directory entry size exceeds file bounds', {
				sizeBlock: entry.sizeBlock,
				byteLength: this.#byteLength,
			})
		}

		if (entry.sizeBlock < MSG_BIG_BLOCK_MIN_DOC_SIZE) {
			const chain = this.#smallBlockChain(entry)
			if (chain.length === 1) {
				const result = new Uint8Array(entry.sizeBlock)
				this.#readSmallBlockData(entry.startBlock, entry.sizeBlock, result, 0)
				return result
			} else if (chain.length > 1) {
				return this.#readSmallChainData(entry, chain)
			}
			return new Uint8Array(0)
		}

		// Large block reading
		let nextBlock = entry.startBlock
		let remaining = entry.sizeBlock
		let position = 0
		const result = new Uint8Array(entry.sizeBlock)
		const visited = new Set<number>()

		while (remaining >= 1) {
			this.#trackSector(visited, nextBlock, 'Entry block', this.#totalSectors, 'total sector count')
			const start = this.#blockOffset(nextBlock)
			const partSize = Math.min(remaining, this.#bigBlockSize)
			this.#assertBounds(start, partSize)
			const src = new Uint8Array(this.#view.buffer, this.#view.byteOffset + start, partSize)
			result.set(src, position)
			position += partSize
			remaining -= partSize
			nextBlock = this.#nextBlock(nextBlock)
		}
		return result
	}

	// === Field Extraction

	#extractFields(): MsgFieldData {
		const root = this.#properties[0]
		if (root === undefined) {
			throw new MsgError('MALFORMED', 'MSG file has no root directory entry')
		}

		const fields: MsgMutableFieldData = {
			kind: 'msg',
			attachments: [],
			recipients: [],
		}
		this.#processDirectory(root, fields, 'root')
		return this.#toFieldData(fields)
	}

	// narrows an unknown-typed mutable field to a string
	#str(mutable: MsgMutableFieldData, key: string): string | undefined {
		const value = mutable[key]
		return typeof value === 'string' ? value : undefined
	}

	// narrows an unknown-typed mutable field to a number
	#num(mutable: MsgMutableFieldData, key: string): number | undefined {
		const value = mutable[key]
		return typeof value === 'number' ? value : undefined
	}

	// narrows an unknown-typed mutable field to a boolean
	#bool(mutable: MsgMutableFieldData, key: string): boolean | undefined {
		const value = mutable[key]
		return typeof value === 'boolean' ? value : undefined
	}

	// narrows an unknown-typed mutable field to binary content
	#bin(mutable: MsgMutableFieldData, key: string): Uint8Array | undefined {
		const value = mutable[key]
		return value instanceof Uint8Array ? value : undefined
	}

	// narrows an unknown-typed mutable field to a recipient role
	#role(mutable: MsgMutableFieldData, key: string): MsgRecipientRole | undefined {
		const value = mutable[key]
		return value === 'to' || value === 'cc' || value === 'bcc' ? value : undefined
	}

	// builds the readonly public MsgFieldData explicitly, field by field,
	// from the mutable accumulator - no type assertions
	#toFieldData(mutable: MsgMutableFieldData): MsgFieldData {
		const attachmentsSource = mutable.attachments
		const attachments =
			attachmentsSource === undefined
				? undefined
				: attachmentsSource.map((entry) => this.#toFieldData(entry))
		const recipientsSource = mutable.recipients
		const recipients =
			recipientsSource === undefined
				? undefined
				: recipientsSource.map((entry) => this.#toFieldData(entry))
		const innerSource = mutable.innerMsgContentFields
		const innerMsgContentFields =
			innerSource === undefined ? undefined : this.#toFieldData(innerSource)

		return {
			kind: mutable.kind,
			// email properties
			subject: this.#str(mutable, 'subject'),
			senderName: this.#str(mutable, 'senderName'),
			senderEmail: this.#str(mutable, 'senderEmail'),
			senderAddressType: this.#str(mutable, 'senderAddressType'),
			senderSmtpAddress: this.#str(mutable, 'senderSmtpAddress'),
			sentRepresentingSmtpAddress: this.#str(mutable, 'sentRepresentingSmtpAddress'),
			body: this.#str(mutable, 'body'),
			headers: this.#str(mutable, 'headers'),
			bodyHtml: this.#str(mutable, 'bodyHtml'),
			html: this.#bin(mutable, 'html'),
			compressedRtf: this.#bin(mutable, 'compressedRtf'),
			messageClass: this.#str(mutable, 'messageClass'),
			messageFlags: this.#num(mutable, 'messageFlags'),
			messageId: this.#str(mutable, 'messageId'),
			internetCodepage: this.#num(mutable, 'internetCodepage'),
			messageCodepage: this.#num(mutable, 'messageCodepage'),
			messageLocaleId: this.#num(mutable, 'messageLocaleId'),
			clientSubmitTime: this.#str(mutable, 'clientSubmitTime'),
			messageDeliveryTime: this.#str(mutable, 'messageDeliveryTime'),
			creationTime: this.#str(mutable, 'creationTime'),
			lastModificationTime: this.#str(mutable, 'lastModificationTime'),
			lastModifierName: this.#str(mutable, 'lastModifierName'),
			creatorSmtpAddress: this.#str(mutable, 'creatorSmtpAddress'),
			lastModifierSmtpAddress: this.#str(mutable, 'lastModifierSmtpAddress'),
			preview: this.#str(mutable, 'preview'),
			conversationTopic: this.#str(mutable, 'conversationTopic'),
			normalizedSubject: this.#str(mutable, 'normalizedSubject'),
			// recipient properties
			name: this.#str(mutable, 'name'),
			email: this.#str(mutable, 'email'),
			addressType: this.#str(mutable, 'addressType'),
			smtpAddress: this.#str(mutable, 'smtpAddress'),
			recipientRole: this.#role(mutable, 'recipientRole'),
			// attachment properties
			extension: this.#str(mutable, 'extension'),
			fileNameShort: this.#str(mutable, 'fileNameShort'),
			fileName: this.#str(mutable, 'fileName'),
			contentId: this.#str(mutable, 'contentId'),
			attachmentHidden: this.#bool(mutable, 'attachmentHidden'),
			mimeType: this.#str(mutable, 'mimeType'),
			contentLength: mutable.contentLength,
			dataId: mutable.dataId,
			folderId: mutable.folderId,
			innerMsgContent: mutable.innerMsgContent,
			innerMsgContentFields,
			attachments,
			recipients,
			// contact properties
			departmentName: this.#str(mutable, 'departmentName'),
			middleName: this.#str(mutable, 'middleName'),
			generation: this.#str(mutable, 'generation'),
			surname: this.#str(mutable, 'surname'),
			givenName: this.#str(mutable, 'givenName'),
			companyName: this.#str(mutable, 'companyName'),
			jobTitle: this.#str(mutable, 'jobTitle'),
			location: this.#str(mutable, 'location'),
			postalAddress: this.#str(mutable, 'postalAddress'),
			streetAddress: this.#str(mutable, 'streetAddress'),
			postalCode: this.#str(mutable, 'postalCode'),
			country: this.#str(mutable, 'country'),
			stateOrProvince: this.#str(mutable, 'stateOrProvince'),
			homePhone: this.#str(mutable, 'homePhone'),
			mobilePhone: this.#str(mutable, 'mobilePhone'),
			businessPhone: this.#str(mutable, 'businessPhone'),
			businessFax: this.#str(mutable, 'businessFax'),
			businessHomePage: this.#str(mutable, 'businessHomePage'),
			namePrefix: this.#str(mutable, 'namePrefix'),
			homeAddressCity: this.#str(mutable, 'homeAddressCity'),
			// appointment / calendar properties
			appointmentStart: this.#str(mutable, 'appointmentStart'),
			appointmentEnd: this.#str(mutable, 'appointmentEnd'),
			clipStart: this.#str(mutable, 'clipStart'),
			clipEnd: this.#str(mutable, 'clipEnd'),
			timeZoneDescription: this.#str(mutable, 'timeZoneDescription'),
			appointmentLocation: this.#str(mutable, 'appointmentLocation'),
			appointmentOldLocation: this.#str(mutable, 'appointmentOldLocation'),
			globalAppointmentId: this.#str(mutable, 'globalAppointmentId'),
			// PidLid - common
			votingResponse: this.#str(mutable, 'votingResponse'),
			internetAccountName: this.#str(mutable, 'internetAccountName'),
			// PidLid - address
			yomiFirstName: this.#str(mutable, 'yomiFirstName'),
			yomiLastName: this.#str(mutable, 'yomiLastName'),
			yomiCompanyName: this.#str(mutable, 'yomiCompanyName'),
			primaryEmailAddress: this.#str(mutable, 'primaryEmailAddress'),
			primaryEmailDisplayName: this.#str(mutable, 'primaryEmailDisplayName'),
			primaryEmailOriginalDisplayName: this.#str(mutable, 'primaryEmailOriginalDisplayName'),
			fileUnder: this.#str(mutable, 'fileUnder'),
			workAddressCity: this.#str(mutable, 'workAddressCity'),
			workAddressStreet: this.#str(mutable, 'workAddressStreet'),
			workAddressState: this.#str(mutable, 'workAddressState'),
			workAddressPostalCode: this.#str(mutable, 'workAddressPostalCode'),
			workAddressCountry: this.#str(mutable, 'workAddressCountry'),
			workAddressCountryCode: this.#str(mutable, 'workAddressCountryCode'),
			addressCountryCode: this.#str(mutable, 'addressCountryCode'),
			contactWebPage: this.#str(mutable, 'contactWebPage'),
			workAddress: this.#str(mutable, 'workAddress'),
			instantMessagingAddress: this.#str(mutable, 'instantMessagingAddress'),
			fax1AddressType: this.#str(mutable, 'fax1AddressType'),
			fax1EmailAddress: this.#str(mutable, 'fax1EmailAddress'),
			fax1OriginalDisplayName: this.#str(mutable, 'fax1OriginalDisplayName'),
			fax2AddressType: this.#str(mutable, 'fax2AddressType'),
			fax2EmailAddress: this.#str(mutable, 'fax2EmailAddress'),
			fax2OriginalDisplayName: this.#str(mutable, 'fax2OriginalDisplayName'),
			fax3AddressType: this.#str(mutable, 'fax3AddressType'),
			fax3EmailAddress: this.#str(mutable, 'fax3EmailAddress'),
			fax3OriginalDisplayName: this.#str(mutable, 'fax3OriginalDisplayName'),
		}
	}

	#processDirectory(entry: MsgDirectoryEntry, fields: MsgMutableFieldData, subClass: string): void {
		const children = entry.children
		if (children === undefined) return

		// Process sub-folders first
		for (let i = 0; i < children.length; i++) {
			const childIndex = children[i]
			const child = this.#properties[childIndex]
			if (child === undefined) continue

			if (child.type === MSG_TYPE_DIRECTORY) {
				this.#processSubDirectory(child, childIndex, fields)
			}
		}

		// Process document streams
		for (let i = 0; i < children.length; i++) {
			const childIndex = children[i]
			const child = this.#properties[childIndex]
			if (child === undefined) continue

			if (child.type === MSG_TYPE_DOCUMENT) {
				if (child.name.indexOf(MSG_PREFIX_DOCUMENT) === 0) {
					this.#processDocument(child, childIndex, fields)
				} else if (child.name === '__properties_version1.0') {
					if (subClass === 'recip' || subClass === 'attachment' || subClass === 'sub') {
						this.#processPropertyStream(child, 8, fields)
					} else if (subClass === 'root') {
						this.#processPropertyStream(child, 32, fields)
					}
				}
			}
		}
	}

	#processSubDirectory(
		child: MsgDirectoryEntry,
		childIndex: number,
		fields: MsgMutableFieldData,
	): void {
		if (child.name.indexOf(MSG_PREFIX_ATTACHMENT) === 0) {
			const attachmentField: MsgMutableFieldData = { kind: 'attachment' }
			if (fields.attachments === undefined) fields.attachments = []
			fields.attachments.push(attachmentField)
			this.#processDirectory(child, attachmentField, 'attachment')
		} else if (child.name.indexOf(MSG_PREFIX_RECIPIENT) === 0) {
			const recipientField: MsgMutableFieldData = { kind: 'recipient' }
			if (fields.recipients === undefined) fields.recipients = []
			fields.recipients.push(recipientField)
			this.#processDirectory(child, recipientField, 'recip')
		} else if (child.name.indexOf(MSG_PREFIX_NAMEID) === 0) {
			this.#processNameIdDirectory(child)
		} else {
			const fieldType = this.#getDirectoryFieldType(child)
			if (fieldType === MSG_FIELD_DIR_TYPE_INNER_MSG) {
				const innerFields: MsgMutableFieldData = {
					kind: 'msg',
					attachments: [],
					recipients: [],
				}
				this.#processDirectory(child, innerFields, 'sub')
				fields.innerMsgContentFields = innerFields
				fields.innerMsgContent = true
				fields.folderId = childIndex
				this.#innerMsgBurners[childIndex] = () => this.#burnFolder(child, true, true)
			}
		}
	}

	#getDirectoryFieldType(entry: MsgDirectoryEntry): string {
		const value = entry.name.substring(12).toLowerCase()
		return value.substring(4, 8)
	}

	#processDocument(
		entry: MsgDirectoryEntry,
		entryIndex: number,
		fields: MsgMutableFieldData,
	): void {
		const value = entry.name.substring(12).toLowerCase()
		const fieldClass = value.substring(0, 4)
		const fieldType = value.substring(4, 8)

		if (fieldClass === MSG_FIELD_CLASS_ATTACHMENT_DATA) {
			fields.dataId = entryIndex
			fields.contentLength = entry.sizeBlock
			return
		}

		const data = this.#readEntry(entry)
		this.#decodeAndAssign(fieldClass, fieldType, data, fields, false)
	}

	#processPropertyStream(
		entry: MsgDirectoryEntry,
		headerSize: number,
		fields: MsgMutableFieldData,
	): void {
		const data = this.#readEntry(entry)
		if (data.length <= headerSize) return

		const propView = new DataView(
			data.buffer,
			data.byteOffset + headerSize,
			data.length - headerSize,
		)
		let offset = 0

		while (offset + 16 <= propView.byteLength) {
			const propertyTag = propView.getUint32(offset, true)
			if (propertyTag === 0) break
			// skip flags (4 bytes)
			offset += 8

			const valueBytes = new Uint8Array(data.buffer, data.byteOffset + headerSize + offset, 8)
			offset += 8

			const fieldClass = toHexLower((propertyTag >>> 16) & 0xffff, 4)
			const fieldType = toHexLower(propertyTag & 0xffff, 4)

			this.#decodeAndAssign(fieldClass, fieldType, valueBytes, fields, true)
		}
	}

	#decodeAndAssign(
		fieldClass: string,
		fieldType: string,
		data: Uint8Array,
		fields: MsgMutableFieldData,
		insideProps: boolean,
	): void {
		const fullTag = `${fieldClass}${fieldType}`
		let key: string | undefined =
			MSG_FIELD_FULL_NAME_MAPPING[fullTag] ?? MSG_FIELD_NAME_MAPPING[fieldClass]

		const classValue = parseInt(fieldClass, 16)
		if (!Number.isNaN(classValue) && classValue >= 0x8000) {
			const keyed = this.#privatePidToKeyed[classValue]
			if (keyed !== undefined) {
				if (keyed.useName) {
					key = keyed.name
				} else if (keyed.propertySet !== undefined && keyed.propertyLid !== undefined) {
					const resolved = this.#resolvePidLid(keyed.propertySet, keyed.propertyLid)
					if (resolved !== undefined) {
						key = resolved
					}
				}
			}
		}

		const decodeAs = MSG_FIELD_TYPE_MAPPING[fieldType]
		let value: unknown = data

		if (decodeAs === 'string') {
			value = removeTrailingNull(readAnsiString(data, this.#options.encoding))
			if (insideProps) key = undefined
		} else if (decodeAs === 'unicode') {
			const view = new DataView(data.buffer, data.byteOffset, data.length)
			value = removeTrailingNull(readUtf16String(view, 0, Math.floor(data.length / 2)))
			if (insideProps) key = undefined
		} else if (decodeAs === 'binary') {
			if (insideProps) key = undefined
		} else if (decodeAs === 'integer') {
			if (data.length >= 4) {
				const dv = new DataView(data.buffer, data.byteOffset, data.length)
				value = dv.getUint32(0, true)
			}
		} else if (decodeAs === 'boolean') {
			if (data.length >= 2) {
				const dv = new DataView(data.buffer, data.byteOffset, data.length)
				value = dv.getUint16(0, true) !== 0
			}
		} else if (decodeAs === 'time') {
			if (data.length >= 8) {
				const dv = new DataView(data.buffer, data.byteOffset, data.length)
				const lo = dv.getUint32(0, true)
				const hi = dv.getUint32(4, true)
				value = fileTimeToUtcString(lo, hi)
			}
		}

		// Resolve recipientRole from integer to string
		if (key === 'recipientRole' && typeof value === 'number') {
			if (value === MSG_MAPI_RECIPIENT_TO) value = 'to' satisfies MsgRecipientRole
			else if (value === MSG_MAPI_RECIPIENT_CC) value = 'cc' satisfies MsgRecipientRole
			else if (value === MSG_MAPI_RECIPIENT_BCC) value = 'bcc' satisfies MsgRecipientRole
		}

		if (key !== undefined) {
			fields[key] = value
		}
	}

	#resolvePidLid(propertySet: string, propertyLid: number): string | undefined {
		const setMapping = MSG_PIDLID_MAPPING[propertySet]
		if (setMapping === undefined) return undefined
		return setMapping[propertyLid]
	}

	// === Named Property ID Resolution (__nameid_version1.0)

	#processNameIdDirectory(dirEntry: MsgDirectoryEntry): void {
		const children = dirEntry.children
		if (children === undefined) return

		let guidTable: Uint8Array | undefined
		let entryTable: Uint8Array | undefined
		let stringTable: Uint8Array | undefined

		for (let i = 0; i < children.length; i++) {
			const childIndex = children[i]
			const child = this.#properties[childIndex]
			if (child === undefined || child.type !== MSG_TYPE_DOCUMENT) continue
			if (child.name.indexOf(MSG_PREFIX_DOCUMENT) !== 0) continue

			const value = child.name.substring(12).toLowerCase()
			const fieldClass = value.substring(0, 4)
			const fieldType = value.substring(4, 8)

			if (fieldClass === '0002' && fieldType === '0102') {
				guidTable = this.#readEntry(child)
			} else if (fieldClass === '0003' && fieldType === '0102') {
				entryTable = this.#readEntry(child)
			} else if (fieldClass === '0004' && fieldType === '0102') {
				stringTable = this.#readEntry(child)
			}
		}

		if (guidTable === undefined || entryTable === undefined || stringTable === undefined) return

		this.#parseEntryStream(entryTable, guidTable, stringTable)
	}

	#parseEntryStream(entryTable: Uint8Array, guidTable: Uint8Array, stringTable: Uint8Array): void {
		const view = new DataView(entryTable.buffer, entryTable.byteOffset, entryTable.length)
		const entryCount = Math.floor(entryTable.length / 8)

		for (let i = 0; i < entryCount; i++) {
			const offset = i * 8
			const nameIdOrStringOffset = view.getUint32(offset, true)
			const indexAndKind = view.getUint16(offset + 4, true)
			const propertyIndex = view.getUint16(offset + 6, true)

			const guidIndex = (indexAndKind >>> 1) & 0x7fff
			const isStringProperty = (nameIdOrStringOffset & 1) !== 0

			if (isStringProperty) {
				const strView = new DataView(stringTable.buffer, stringTable.byteOffset, stringTable.length)
				const strOffset = nameIdOrStringOffset >>> 0
				if (strOffset + 4 <= stringTable.length) {
					const numTextBytes = strView.getUint32(strOffset, true)
					const charCount = Math.floor(numTextBytes / 2)
					if (strOffset + 4 + numTextBytes <= stringTable.length) {
						const name = readUtf16String(strView, strOffset + 4, charCount)
						this.#privatePidToKeyed[0x8000 | propertyIndex] = {
							useName: true,
							name,
						}
					}
				}
			} else {
				let propertySet: string | undefined
				if (guidIndex === 1) {
					propertySet = '00020328-0000-0000-c000-000000000046'
				} else if (guidIndex === 2) {
					propertySet = '00020329-0000-0000-c000-000000000046'
				} else {
					const guidOffset = 16 * (guidIndex - 3)
					if (guidOffset >= 0 && guidOffset + 16 <= guidTable.length) {
						propertySet = msftUuidStringify(guidTable, guidOffset)
					}
				}

				if (propertySet !== undefined) {
					this.#privatePidToKeyed[0x8000 | propertyIndex] = {
						useName: false,
						propertySet,
						propertyLid: nameIdOrStringOffset,
					}
				}
			}
		}
	}

	// === Burner (CFB reconstitution for embedded MSG)

	#burnFolder(
		folder: MsgDirectoryEntry,
		padTopLevelPropertyStream: boolean,
		includeRootNameId: boolean,
	): Uint8Array {
		const entries: MsgBurnerEntry[] = [
			{
				name: 'Root Entry',
				type: MSG_TYPE_ROOT,
				children: [],
				length: 0,
			},
		]
		this.#registerBurnerFolder(entries, 0, folder, padTopLevelPropertyStream, includeRootNameId)
		const burner = new MsgBurner()
		return burner.burn(entries)
	}

	#registerBurnerFolder(
		entries: MsgBurnerEntry[],
		parentIndex: number,
		folder: MsgDirectoryEntry,
		padPropertyStream: boolean,
		includeRootNameId: boolean,
	): void {
		const children = folder.children
		if (children === undefined) return

		const parentChildren = entries[parentIndex].children
		if (parentChildren === undefined) return

		// Register document streams
		for (let i = 0; i < children.length; i++) {
			const childIndex = children[i]
			const child = this.#properties[childIndex]
			if (child === undefined || child.type !== MSG_TYPE_DOCUMENT) continue

			let provider = () => this.#readEntry(child)
			let length = child.sizeBlock

			// Embedded MSG storages use the sub-message property stream layout.
			// When promoting one to a standalone Root Entry, the top-level
			// __properties_version1.0 stream needs 8 bytes inserted at offset 24.
			if (padPropertyStream && child.name === '__properties_version1.0') {
				const originalProvider = provider
				provider = () => {
					const src = originalProvider()
					const dst = new Uint8Array(src.length + 8)
					dst.set(src.subarray(0, 24), 0)
					dst.set(src.subarray(24), 32)
					return dst
				}
				length = length + 8
			}

			const subIndex = entries.length
			parentChildren.push(subIndex)
			entries.push({
				name: child.name,
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: provider,
				length,
			})
		}

		// Include root __nameid_version1.0 when rebuilding an embedded MSG as a
		// standalone file, because the embedded storage does not carry it itself.
		if (includeRootNameId) {
			const rootProp = this.#properties[0]
			if (rootProp !== undefined && rootProp.children !== undefined) {
				for (let i = 0; i < rootProp.children.length; i++) {
					const rootChildIndex = rootProp.children[i]
					const rootChild = this.#properties[rootChildIndex]
					if (
						rootChild !== undefined &&
						rootChild.type === MSG_TYPE_DIRECTORY &&
						rootChild.name === MSG_PREFIX_NAMEID
					) {
						const subIndex = entries.length
						parentChildren.push(subIndex)
						entries.push({
							name: rootChild.name,
							type: MSG_TYPE_DIRECTORY,
							children: [],
							length: 0,
						})
						this.#registerBurnerFolder(entries, subIndex, rootChild, false, false)
					}
				}
			}
		}

		// Register sub-directories
		for (let i = 0; i < children.length; i++) {
			const childIndex = children[i]
			const child = this.#properties[childIndex]
			if (child === undefined || child.type !== MSG_TYPE_DIRECTORY) continue

			const subIndex = entries.length
			parentChildren.push(subIndex)
			entries.push({
				name: child.name,
				type: MSG_TYPE_DIRECTORY,
				children: [],
				length: 0,
			})
			this.#registerBurnerFolder(entries, subIndex, child, false, false)
		}
	}
}
