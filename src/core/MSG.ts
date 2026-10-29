/**
 * Parses .eml (RFC 2822 / MIME) and .msg (Outlook CFB/OLE2 compound
 * binary) files into a structured email chain, and — for .msg input —
 * exposes the raw MAPI field tree plus attachment/burn access. Parsing
 * is eager: the constructor either fully parses the input or throws a
 * typed {@link MSGError}. A pure-ES MIME parser handles .eml, and native
 * DataView operations handle the CFB format. Runtime type tests come from
 * `@orkestrel/contract`.
 */

import type {
	MSGInterface,
	MSGInput,
	EmailInput,
	MSGOptions,
	EmailChain,
	MSGFieldData,
	MSGAttachment,
	MSGRecipientRole,
	MSGDirectoryEntry,
	MSGMutableFieldData,
	MSGNameIdEntry,
	MSGBurnerEntry,
	MSGSourceInterface,
} from './types.js'
import {
	isArrayBuffer,
	isBoolean,
	isFiniteNumber,
	isNumber,
	isString,
	isUint8Array,
} from '@orkestrel/contract'
import { MSGError } from './errors.js'
import {
	MSG_END_OF_CHAIN,
	MSG_UNUSED_BLOCK,
	MSG_SECTOR_SIZE,
	MSG_L_BIG_BLOCK_SIZE,
	MSG_L_BIG_BLOCK_MARK,
	MSG_MINI_SECTOR_SIZE,
	MSG_MINI_STREAM_CUTOFF,
	MSG_HEADER_PROPERTY_START_OFFSET,
	MSG_HEADER_BAT_START_OFFSET,
	MSG_HEADER_BAT_COUNT_OFFSET,
	MSG_HEADER_SBAT_START_OFFSET,
	MSG_HEADER_SBAT_COUNT_OFFSET,
	MSG_HEADER_XBAT_START_OFFSET,
	MSG_HEADER_XBAT_COUNT_OFFSET,
	MSG_PROP_NO_INDEX,
	MSG_DIRECTORY_ENTRY_SIZE,
	MSG_PROP_NAME_SIZE_OFFSET,
	MSG_PROP_CATEGORY_OFFSET,
	MSG_PROP_PREVIOUS_PROPERTY_OFFSET,
	MSG_PROP_NEXT_PROPERTY_OFFSET,
	MSG_PROP_CHILD_PROPERTY_OFFSET,
	MSG_PROP_START_BLOCK_OFFSET,
	MSG_PROP_SIZE_OFFSET,
	MSG_CATEGORY_DIRECTORY,
	MSG_CATEGORY_DOCUMENT,
	MSG_CATEGORY_ROOT,
	MSG_PREFIX_ATTACHMENT,
	MSG_PREFIX_RECIPIENT,
	MSG_PREFIX_DOCUMENT,
	MSG_PREFIX_NAMEID,
	MSG_FIELD_NAMES,
	MSG_FIELD_FULL_NAMES,
	MSG_FIELD_TYPES,
	MSG_FIELD_CLASS_ATTACHMENT_DATA,
	MSG_FIELD_DIR_TYPE_INNER_MSG,
	MSG_PIDLIDS,
	MSG_MAPI_RECIPIENT_TO,
	MSG_MAPI_RECIPIENT_CC,
	MSG_MAPI_RECIPIENT_BCC,
	MSG_BURNER_NAME_MAX,
	MSG_MAX_HIERARCHY_DEPTH,
} from './constants.js'
import {
	decodeUTF8,
	detectFormat,
	isMSGFile,
	truncateAtNull,
	readUTF16String,
	decodeText,
	fileTimeToUTCString,
	toHexLower,
	readMicrosoftUUID,
} from './helpers.js'
import { parseMIMEPart } from './parsers.js'
import { burnCFB, extractMessage, extractMessageFromMSG } from './shapers.js'

// === MSG

/**
 * Parses raw `.eml` or `.msg` file bytes into a structured {@link EmailChain}, exposing — for
 * `.msg` input — the raw MAPI field tree, attachment binary access, and CFB reconstitution.
 *
 * @remarks
 * Every parsing step treats the input as untrusted: sector and property chains are cycle-guarded
 * and length-capped, every raw byte range is bounds-checked before a view is constructed over it,
 * and every failure surfaces as a typed {@link MSGError} rather than a raw `RangeError` or
 * `TypeError`.
 *
 * @example
 * ```ts
 * import { MSG } from '@src/core'
 *
 * const msg = new MSG({ bytes, name: 'message.eml' })
 * console.log(msg.chain.format)
 * console.log(msg.chain.messages[0].text)
 * ```
 */
export class MSG implements MSGInterface {
	readonly #options: MSGOptions
	readonly #chain: EmailChain
	readonly #view: DataView
	readonly #byteLength: number
	readonly #totalSectors: number
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
	#properties: MSGDirectoryEntry[] = []
	#bigBlockTable: number[] = []
	#fields: MSGFieldData | undefined
	#privatePidToKeyed: Record<number, MSGNameIdEntry> = {}
	#innerMSGDirectories: Record<number, MSGDirectoryEntry> = {}

	/**
	 * Creates and eagerly parses an MSG/EML instance.
	 *
	 * @param input - Raw MSG bytes, or an {@link EmailInput} for EML/MSG parsing
	 * @param options - Parser configuration
	 * @throws {@link MSGError} with code `UNSUPPORTED`, `MALFORMED`, `CYCLE`,
	 * or `RANGE` when the input cannot be parsed
	 */
	constructor(input: MSGInput, options?: MSGOptions) {
		this.#options = { ...(options ?? {}) }

		const raw = isUint8Array(input) || isArrayBuffer(input)
		const inputData: EmailInput = isUint8Array(input)
			? { bytes: input }
			: isArrayBuffer(input)
				? { bytes: new Uint8Array(input) }
				: input
		const bytes = inputData.bytes
		const name = inputData.name
		const mime = inputData.mime
		const sniffFormat = !raw

		this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
		this.#byteLength = bytes.byteLength
		this.#totalSectors = Math.ceil(this.#byteLength / MSG_SECTOR_SIZE)

		const format = sniffFormat
			? (detectFormat(name, mime) ?? (isMSGFile(this.#view) ? 'msg' : undefined))
			: 'msg'

		if (format === undefined) {
			throw new MSGError(
				'UNSUPPORTED',
				`"${name ?? 'input'}" — only .eml and .msg files are supported`,
				{
					name,
					mime,
				},
			)
		}

		if (format === 'msg') {
			this.#parseHeader()
			this.#bat = this.#readBat()
			if (this.#xbatCount > 0) {
				this.#readXbat()
			}
			this.#sbat = this.#readSbat()
			this.#properties = this.#readProperties(this.#propertyStart)
			this.#bigBlockTable = this.#buildBigBlockTable()
			this.#privatePidToKeyed = {}
			this.#innerMSGDirectories = {}

			const fields = this.#extractFields()
			this.#fields = fields

			const source: MSGSourceInterface = {
				parse: this.#readFields.bind(this),
				attachment: this.attachment.bind(this),
			}
			const message = extractMessageFromMSG(source)
			this.#chain = { format: 'msg', messages: [message] }
		} else {
			const text = decodeUTF8(bytes)
			const root = parseMIMEPart(text)
			const message = extractMessage(root)
			this.#chain = { format: 'eml', messages: [message] }
		}
	}

	/**
	 * Returns the current parser configuration.
	 *
	 * @returns A copy of the configured {@link MSGOptions} — the internal
	 * reference is never leaked
	 */
	get options(): MSGOptions {
		return { ...this.#options }
	}

	/**
	 * Holds the parsed email chain. The detected format is available through
	 * `chain.format`.
	 */
	get chain(): EmailChain {
		return this.#chain
	}

	/**
	 * Holds parsed MSG field data, or `undefined` when the parsed format is
	 * `'eml'`.
	 */
	get fields(): MSGFieldData | undefined {
		return this.#fields
	}

	/**
	 * Reads attachment binary content by index.
	 *
	 * Requires `'msg'` input. For `'eml'` input the MAPI field tree this index
	 * addresses is absent, so every index throws; read an `.eml` file's
	 * attachments from `chain.messages[0].attachments` instead.
	 *
	 * @param index - Zero-based index into the parsed attachment list
	 * @returns File name and raw binary content
	 * @throws {@link MSGError} with code `RANGE` when the index is out of bounds,
	 * and for every index when the parsed format is `'eml'`
	 */
	attachment(index: number): MSGAttachment {
		if (this.#fields === undefined) {
			throw new MSGError('RANGE', `Attachment index ${index} out of range`, { index })
		}

		const attachments = this.#fields.attachments
		if (attachments === undefined || index < 0 || index >= attachments.length) {
			throw new MSGError('RANGE', `Attachment index ${index} out of range`, { index })
		}

		const attach = attachments[index]
		if (attach === undefined) {
			throw new MSGError('RANGE', `Attachment index ${index} out of range`, { index })
		}
		if (attach.innerMSGContent === true && isNumber(attach.folderId)) {
			const name = isString(attach.name) ? attach.name : 'embedded'
			const directory = this.#innerMSGDirectories[attach.folderId]
			const content =
				directory === undefined ? new Uint8Array(0) : this.#burnFolder(directory, true, true)
			return { name: `${name}.msg`, bytes: content }
		}

		if (!isNumber(attach.dataId) || attach.dataId < 0 || attach.dataId >= this.#properties.length) {
			throw new MSGError('RANGE', 'Attachment has no valid data reference', { index })
		}

		const entry = this.#properties[attach.dataId]
		if (entry === undefined) {
			throw new MSGError('RANGE', 'Attachment has no valid data reference', { index })
		}
		const content = this.#readEntry(entry)
		const name = isString(attach.fileName)
			? attach.fileName
			: isString(attach.fileNameShort)
				? attach.fileNameShort
				: isString(attach.name)
					? attach.name
					: 'unknown'

		return { name, bytes: content }
	}

	/**
	 * Rebuilds the parsed MSG as a standalone CFB/.msg binary.
	 *
	 * @returns Complete CFB byte stream
	 * @throws {@link MSGError} with code `BURN` when the parsed structure
	 * cannot be reconstituted
	 */
	burn(): Uint8Array {
		if (this.#chain.format !== 'msg' || this.#fields === undefined) {
			throw new MSGError('BURN', 'Unable to burn a non-message field data structure', {
				format: this.#chain.format,
			})
		}

		const root = this.#properties[0]
		if (root === undefined) {
			throw new MSGError('BURN', 'Unable to burn MSG file without a root entry')
		}

		return this.#burnFolder(root, false, false)
	}

	// === Header Parsing

	#readFields(): MSGFieldData {
		const fields = this.#fields
		if (fields === undefined) {
			throw new MSGError('MALFORMED', 'MSG field data is unavailable')
		}
		return fields
	}

	#parseHeader(): void {
		if (!isMSGFile(this.#view)) {
			throw new MSGError('UNSUPPORTED', 'Input is not a recognized CFB/MSG file')
		}
		if (this.#byteLength < MSG_SECTOR_SIZE) {
			throw new MSGError('MALFORMED', 'File is smaller than the minimum CFB header size', {
				byteLength: this.#byteLength,
			})
		}

		const v = this.#view
		const sectorMark = v.getUint8(30)
		this.#bigBlockSize =
			sectorMark === MSG_L_BIG_BLOCK_MARK ? MSG_L_BIG_BLOCK_SIZE : MSG_SECTOR_SIZE
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
			throw new MSGError('MALFORMED', `CFB header field '${name}' is out of range`, {
				field: name,
				value,
			})
		}
	}

	// bounds guard shared by every raw byte-range read over the file view
	#assertBounds(start: number, length: number): void {
		if (start < 0 || length < 0 || start + length > this.#byteLength) {
			throw new MSGError('MALFORMED', 'Computed byte range exceeds file bounds', {
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
			throw new MSGError('CYCLE', `${label} chain revisits sector ${sector}`, { sector })
		}
		if (visited.size >= limit) {
			throw new MSGError('CYCLE', `${label} chain exceeds ${capacityLabel}`, {
				limit,
			})
		}
		visited.add(sector)
	}

	// === FAT (Block Allocation Table)

	#batCountInHeader(): number {
		const max = (MSG_SECTOR_SIZE - MSG_HEADER_BAT_START_OFFSET) / 4
		return Math.min(this.#batCount, max)
	}

	#readBat(): number[] {
		const count = this.#batCountInHeader()
		return Array.from({ length: count }, (_, index) =>
			this.#view.getInt32(MSG_HEADER_BAT_START_OFFSET + index * 4, true),
		)
	}

	#blockOffset(sector: number): number {
		if (sector < 0 || sector >= this.#totalSectors) {
			throw new MSGError('MALFORMED', `Sector index out of range: ${sector}`, {
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
		const visited = new Set<number>()
		const steps: Array<{ readonly sector: number; readonly next: number }> = []
		while (steps.length < this.#sbatCount) {
			const startIndex = steps.at(-1)?.next ?? this.#sbatStart
			if (startIndex === 0 || startIndex === MSG_END_OF_CHAIN) break
			this.#trackSector(visited, startIndex, 'SBAT', this.#totalSectors, 'total sector count')
			steps.push({ sector: startIndex, next: this.#nextBlock(startIndex) })
		}
		return steps.map((step) => step.sector)
	}

	// === XBAT (Extended BAT / DIFAT)

	#readXbat(): void {
		const headerBatCount = this.#batCountInHeader()
		const steps: Array<{ readonly next: number; readonly sectors: readonly number[] }> = []
		const visited = new Set<number>()

		while (steps.length < this.#xbatCount) {
			const i = steps.length
			const nextSector = steps.at(-1)?.next ?? this.#xbatStart
			const remaining = Math.max(0, this.#batCount - headerBatCount - i * this.#xBlockLength)
			this.#trackSector(visited, nextSector, 'XBAT', this.#totalSectors, 'total sector count')
			const blockOffset = this.#blockOffset(nextSector)
			this.#assertBounds(blockOffset, this.#bigBlockSize)
			const toProcess = Math.min(remaining, this.#xBlockLength)
			const sectors: number[] = []

			for (const j of Array.from({ length: Math.max(0, toProcess) }, (_, index) => index)) {
				const sector = this.#view.getInt32(blockOffset + j * 4, true)
				if (sector === MSG_UNUSED_BLOCK || sector === MSG_END_OF_CHAIN) break
				sectors.push(sector)
			}
			const next = this.#view.getInt32(blockOffset + this.#xBlockLength * 4, true)
			steps.push({ next, sectors })
			if (next === MSG_UNUSED_BLOCK || next === MSG_END_OF_CHAIN) break
		}
		for (const step of steps) {
			for (const sector of step.sectors) this.#bat.push(sector)
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
		return truncateAtNull(readUTF16String(this.#view, offset, charCount))
	}

	#readDirectoryEntry(offset: number): MSGDirectoryEntry {
		const v = this.#view
		return {
			category: v.getUint8(offset + MSG_PROP_CATEGORY_OFFSET),
			name: this.#readEntryName(offset),
			previousProperty: v.getInt32(offset + MSG_PROP_PREVIOUS_PROPERTY_OFFSET, true),
			nextProperty: v.getInt32(offset + MSG_PROP_NEXT_PROPERTY_OFFSET, true),
			childProperty: v.getInt32(offset + MSG_PROP_CHILD_PROPERTY_OFFSET, true),
			startBlock: v.getInt32(offset + MSG_PROP_START_BLOCK_OFFSET, true),
			sizeBlock: v.getInt32(offset + MSG_PROP_SIZE_OFFSET, true),
		}
	}

	#readProperties(propertyStart: number): MSGDirectoryEntry[] {
		const steps: Array<{
			readonly next: number
			readonly entries: readonly MSGDirectoryEntry[]
		}> = []
		const visited = new Set<number>()

		while (true) {
			const currentSector = steps.at(-1)?.next ?? propertyStart
			if (currentSector === MSG_END_OF_CHAIN) break
			this.#trackSector(
				visited,
				currentSector,
				'Property',
				this.#totalSectors,
				'total sector count',
			)
			const entryCount = this.#bigBlockSize / MSG_DIRECTORY_ENTRY_SIZE
			const start = this.#blockOffset(currentSector)
			const props: MSGDirectoryEntry[] = []

			for (const i of Array.from({ length: entryCount }, (_, index) => index)) {
				const offset = start + i * MSG_DIRECTORY_ENTRY_SIZE
				if (offset + MSG_DIRECTORY_ENTRY_SIZE > this.#byteLength) break
				const entryCategory = this.#view.getUint8(offset + MSG_PROP_CATEGORY_OFFSET)

				if (
					entryCategory === MSG_CATEGORY_ROOT ||
					entryCategory === MSG_CATEGORY_DIRECTORY ||
					entryCategory === MSG_CATEGORY_DOCUMENT
				) {
					props.push(this.#readDirectoryEntry(offset))
				} else {
					props.push({
						category: entryCategory,
						name: '',
						previousProperty: -1,
						nextProperty: -1,
						childProperty: -1,
						startBlock: 0,
						sizeBlock: 0,
					})
				}
			}
			steps.push({ next: this.#nextBlock(currentSector), entries: props })
		}

		const props = steps.flatMap((step) => step.entries)
		if (props.length > 0) {
			this.#buildHierarchy(props, 0, new Set<number>(), 0)
		}
		return props
	}

	#buildHierarchy(
		props: MSGDirectoryEntry[],
		nodeIndex: number,
		visited: Set<number>,
		depth: number,
	): void {
		const node = props[nodeIndex]
		if (node === undefined || node.childProperty === MSG_PROP_NO_INDEX) return

		if (depth > MSG_MAX_HIERARCHY_DEPTH) {
			throw new MSGError('CYCLE', 'Directory hierarchy nesting exceeds maximum depth', {
				depth,
				max: MSG_MAX_HIERARCHY_DEPTH,
			})
		}
		if (visited.has(nodeIndex)) {
			throw new MSGError('CYCLE', `Directory hierarchy revisits property index ${nodeIndex}`, {
				index: nodeIndex,
			})
		}
		if (visited.size >= props.length) {
			throw new MSGError('CYCLE', 'Directory hierarchy traversal exceeds total property count', {
				limit: props.length,
			})
		}
		visited.add(nodeIndex)
		const children: number[] = []

		const siblingVisited = new Set<number>([node.childProperty])
		const stack: Array<{ readonly emit: boolean; readonly index: number }> = [
			{ emit: false, index: node.childProperty },
		]

		while (stack.length > 0) {
			const step = stack.pop()
			if (step === undefined) break
			const current = props[step.index]
			if (current === undefined) continue

			if (step.emit) {
				children.push(step.index)
			} else {
				if (current.category === MSG_CATEGORY_DIRECTORY) {
					this.#buildHierarchy(props, step.index, visited, depth + 1)
				}
				if (current.nextProperty !== MSG_PROP_NO_INDEX) {
					if (siblingVisited.has(current.nextProperty)) {
						throw new MSGError(
							'CYCLE',
							`Directory sibling chain revisits property index ${current.nextProperty}`,
							{
								index: current.nextProperty,
							},
						)
					}
					siblingVisited.add(current.nextProperty)
					stack.push({ emit: false, index: current.nextProperty })
				}
				stack.push({ emit: true, index: step.index })
				if (current.previousProperty !== MSG_PROP_NO_INDEX) {
					if (siblingVisited.has(current.previousProperty)) {
						throw new MSGError(
							'CYCLE',
							`Directory sibling chain revisits property index ${current.previousProperty}`,
							{ index: current.previousProperty },
						)
					}
					siblingVisited.add(current.previousProperty)
					stack.push({ emit: false, index: current.previousProperty })
				}
			}
		}
		props[nodeIndex] = { ...node, children }
	}

	// === Big Block Table (mini-stream container chain)

	#buildBigBlockTable(): number[] {
		const rootProp = this.#properties[0]
		if (rootProp === undefined) return []

		const steps: Array<{ readonly sector: number; readonly next: number }> = []
		const visited = new Set<number>()
		while (true) {
			const nextBlock = steps.at(-1)?.next ?? rootProp.startBlock
			if (nextBlock === MSG_END_OF_CHAIN) break
			this.#trackSector(visited, nextBlock, 'Big block', this.#totalSectors, 'total sector count')
			steps.push({ sector: nextBlock, next: this.#nextBlock(nextBlock) })
		}
		return steps.map((step) => step.sector)
	}

	// === Data Reading

	#readSmallBlockData(
		startBlock: number,
		blockSize: number,
		dest: Uint8Array,
		destOffset: number,
	): void {
		const byteOffset = startBlock * MSG_MINI_SECTOR_SIZE
		const bigBlockNumber = Math.floor(byteOffset / this.#bigBlockSize)
		const bigBlockOffset = byteOffset % this.#bigBlockSize

		const sector = this.#bigBlockTable[bigBlockNumber]
		if (sector === undefined) return
		const start = this.#blockOffset(sector) + bigBlockOffset
		this.#assertBounds(start, blockSize)
		const src = new Uint8Array(this.#view.buffer, this.#view.byteOffset + start, blockSize)
		dest.set(src, destOffset)
	}

	#readSmallChainData(entry: MSGDirectoryEntry, chain: number[]): Uint8Array {
		const result = new Uint8Array(entry.sizeBlock)
		for (const [index, block] of chain.entries()) {
			const idx = Math.min(index * MSG_MINI_SECTOR_SIZE, result.length)
			const readLen = Math.min(result.length - idx, MSG_MINI_SECTOR_SIZE)
			this.#readSmallBlockData(block, readLen, result, idx)
		}
		return result
	}

	#smallBlockChain(entry: MSGDirectoryEntry): number[] {
		const steps: Array<{ readonly sector: number; readonly next: number }> = []
		const visited = new Set<number>()
		// the mini-FAT lives in this.#sbat's big sectors, each holding
		// bigBlockLength int32 entries - that flat entry count, not the
		// file's big-sector count, bounds a legitimate mini-stream chain
		const capacity = this.#sbat.length * this.#bigBlockLength
		while (true) {
			const next = steps.at(-1)?.next ?? entry.startBlock
			if (next === MSG_END_OF_CHAIN) break
			if (next < 0 || next >= capacity) {
				throw new MSGError('MALFORMED', `Small block index ${next} exceeds mini-FAT capacity`, {
					sector: next,
					capacity,
				})
			}
			this.#trackSector(visited, next, 'Small block', capacity, 'mini-FAT capacity')
			steps.push({ sector: next, next: this.#nextBlockSmall(next) })
		}
		return steps.map((step) => step.sector)
	}

	#readEntry(entry: MSGDirectoryEntry): Uint8Array {
		if (entry.sizeBlock <= 0) return new Uint8Array(0)
		if (entry.sizeBlock > this.#byteLength) {
			throw new MSGError('MALFORMED', 'Directory entry size exceeds file bounds', {
				sizeBlock: entry.sizeBlock,
				byteLength: this.#byteLength,
			})
		}

		if (entry.sizeBlock < MSG_MINI_STREAM_CUTOFF) {
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
		const steps: Array<{
			readonly next: number
			readonly position: number
			readonly bytes: Uint8Array
		}> = []
		const result = new Uint8Array(entry.sizeBlock)
		const visited = new Set<number>()

		while (true) {
			const nextBlock = steps.at(-1)?.next ?? entry.startBlock
			const position = steps.length * this.#bigBlockSize
			const remaining = entry.sizeBlock - position
			if (remaining < 1) break
			this.#trackSector(visited, nextBlock, 'Entry block', this.#totalSectors, 'total sector count')
			const start = this.#blockOffset(nextBlock)
			const partSize = Math.min(remaining, this.#bigBlockSize)
			this.#assertBounds(start, partSize)
			const src = new Uint8Array(this.#view.buffer, this.#view.byteOffset + start, partSize)
			steps.push({ bytes: src.slice(), position, next: this.#nextBlock(nextBlock) })
		}
		for (const step of steps) result.set(step.bytes, step.position)
		return result
	}

	// === Field Extraction

	#extractFields(): MSGFieldData {
		const root = this.#properties[0]
		if (root === undefined) {
			throw new MSGError('MALFORMED', 'MSG file has no root directory entry')
		}

		const fields: MSGMutableFieldData = {
			category: 'msg',
			attachments: [],
			recipients: [],
		}
		this.#processDirectory(root, fields, 32)
		return this.#toFieldData(fields)
	}

	// narrows an unknown-typed mutable field to a string
	#string(mutable: MSGMutableFieldData, key: string): string | undefined {
		const value = mutable[key]
		return isString(value) ? value : undefined
	}

	// narrows an unknown-typed mutable field to a number
	#number(mutable: MSGMutableFieldData, key: string): number | undefined {
		const value = mutable[key]
		return isNumber(value) ? value : undefined
	}

	// narrows an unknown-typed mutable field to a boolean
	#boolean(mutable: MSGMutableFieldData, key: string): boolean | undefined {
		const value = mutable[key]
		return isBoolean(value) ? value : undefined
	}

	// narrows an unknown-typed mutable field to binary content
	#binary(mutable: MSGMutableFieldData, key: string): Uint8Array | undefined {
		const value = mutable[key]
		return isUint8Array(value) ? value : undefined
	}

	// narrows an unknown-typed mutable field to a recipient role
	#role(mutable: MSGMutableFieldData, key: string): MSGRecipientRole | undefined {
		const value = mutable[key]
		return value === 'to' || value === 'cc' || value === 'bcc' ? value : undefined
	}

	// builds the readonly public MSGFieldData explicitly, field by field,
	// from the mutable accumulator - no type assertions
	#toFieldData(mutable: MSGMutableFieldData): MSGFieldData {
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
		const innerSource = mutable.innerMSGContentFields
		const innerMSGContentFields =
			innerSource === undefined ? undefined : this.#toFieldData(innerSource)

		const entries = [
			// email properties
			['subject', this.#string(mutable, 'subject')],
			['senderName', this.#string(mutable, 'senderName')],
			['senderEmail', this.#string(mutable, 'senderEmail')],
			['senderAddressType', this.#string(mutable, 'senderAddressType')],
			['senderSMTPAddress', this.#string(mutable, 'senderSMTPAddress')],
			['sentRepresentingSMTPAddress', this.#string(mutable, 'sentRepresentingSMTPAddress')],
			['body', this.#string(mutable, 'body')],
			['headers', this.#string(mutable, 'headers')],
			['bodyHTML', this.#string(mutable, 'bodyHTML')],
			['html', this.#binary(mutable, 'html')],
			['compressedRTF', this.#binary(mutable, 'compressedRTF')],
			['messageClass', this.#string(mutable, 'messageClass')],
			['messageFlags', this.#number(mutable, 'messageFlags')],
			['messageId', this.#string(mutable, 'messageId')],
			['internetCodepage', this.#number(mutable, 'internetCodepage')],
			['messageCodepage', this.#number(mutable, 'messageCodepage')],
			['messageLocaleId', this.#number(mutable, 'messageLocaleId')],
			['clientSubmitTime', this.#string(mutable, 'clientSubmitTime')],
			['messageDeliveryTime', this.#string(mutable, 'messageDeliveryTime')],
			['creationTime', this.#string(mutable, 'creationTime')],
			['lastModificationTime', this.#string(mutable, 'lastModificationTime')],
			['lastModifierName', this.#string(mutable, 'lastModifierName')],
			['creatorSMTPAddress', this.#string(mutable, 'creatorSMTPAddress')],
			['lastModifierSMTPAddress', this.#string(mutable, 'lastModifierSMTPAddress')],
			['preview', this.#string(mutable, 'preview')],
			['conversationTopic', this.#string(mutable, 'conversationTopic')],
			['normalizedSubject', this.#string(mutable, 'normalizedSubject')],
			// recipient properties
			['name', this.#string(mutable, 'name')],
			['email', this.#string(mutable, 'email')],
			['addressType', this.#string(mutable, 'addressType')],
			['smtpAddress', this.#string(mutable, 'smtpAddress')],
			['recipientRole', this.#role(mutable, 'recipientRole')],
			// attachment properties
			['extension', this.#string(mutable, 'extension')],
			['fileNameShort', this.#string(mutable, 'fileNameShort')],
			['fileName', this.#string(mutable, 'fileName')],
			['contentId', this.#string(mutable, 'contentId')],
			['attachmentHidden', this.#boolean(mutable, 'attachmentHidden')],
			['mimeType', this.#string(mutable, 'mimeType')],
			['contentLength', mutable.contentLength],
			['dataId', mutable.dataId],
			['folderId', mutable.folderId],
			['innerMSGContent', mutable.innerMSGContent],
			['innerMSGContentFields', innerMSGContentFields],
			['attachments', attachments],
			['recipients', recipients],
			// contact properties
			['departmentName', this.#string(mutable, 'departmentName')],
			['middleName', this.#string(mutable, 'middleName')],
			['generation', this.#string(mutable, 'generation')],
			['surname', this.#string(mutable, 'surname')],
			['givenName', this.#string(mutable, 'givenName')],
			['companyName', this.#string(mutable, 'companyName')],
			['jobTitle', this.#string(mutable, 'jobTitle')],
			['location', this.#string(mutable, 'location')],
			['postalAddress', this.#string(mutable, 'postalAddress')],
			['streetAddress', this.#string(mutable, 'streetAddress')],
			['postalCode', this.#string(mutable, 'postalCode')],
			['country', this.#string(mutable, 'country')],
			['stateOrProvince', this.#string(mutable, 'stateOrProvince')],
			['homePhone', this.#string(mutable, 'homePhone')],
			['mobilePhone', this.#string(mutable, 'mobilePhone')],
			['businessPhone', this.#string(mutable, 'businessPhone')],
			['businessFax', this.#string(mutable, 'businessFax')],
			['businessHomePage', this.#string(mutable, 'businessHomePage')],
			['namePrefix', this.#string(mutable, 'namePrefix')],
			['homeAddressCity', this.#string(mutable, 'homeAddressCity')],
			// appointment / calendar properties
			['appointmentStart', this.#string(mutable, 'appointmentStart')],
			['appointmentEnd', this.#string(mutable, 'appointmentEnd')],
			['clipStart', this.#string(mutable, 'clipStart')],
			['clipEnd', this.#string(mutable, 'clipEnd')],
			['timeZoneDescription', this.#string(mutable, 'timeZoneDescription')],
			['appointmentLocation', this.#string(mutable, 'appointmentLocation')],
			['appointmentOldLocation', this.#string(mutable, 'appointmentOldLocation')],
			['globalAppointmentId', this.#string(mutable, 'globalAppointmentId')],
			// PidLid - common
			['votingResponse', this.#string(mutable, 'votingResponse')],
			['internetAccountName', this.#string(mutable, 'internetAccountName')],
			// PidLid - address
			['yomiFirstName', this.#string(mutable, 'yomiFirstName')],
			['yomiLastName', this.#string(mutable, 'yomiLastName')],
			['yomiCompanyName', this.#string(mutable, 'yomiCompanyName')],
			['primaryEmailAddress', this.#string(mutable, 'primaryEmailAddress')],
			['primaryEmailDisplayName', this.#string(mutable, 'primaryEmailDisplayName')],
			['primaryEmailOriginalDisplayName', this.#string(mutable, 'primaryEmailOriginalDisplayName')],
			['fileUnder', this.#string(mutable, 'fileUnder')],
			['workAddressCity', this.#string(mutable, 'workAddressCity')],
			['workAddressStreet', this.#string(mutable, 'workAddressStreet')],
			['workAddressState', this.#string(mutable, 'workAddressState')],
			['workAddressPostalCode', this.#string(mutable, 'workAddressPostalCode')],
			['workAddressCountry', this.#string(mutable, 'workAddressCountry')],
			['workAddressCountryCode', this.#string(mutable, 'workAddressCountryCode')],
			['addressCountryCode', this.#string(mutable, 'addressCountryCode')],
			['contactWebPage', this.#string(mutable, 'contactWebPage')],
			['workAddress', this.#string(mutable, 'workAddress')],
			['instantMessagingAddress', this.#string(mutable, 'instantMessagingAddress')],
			['fax1AddressType', this.#string(mutable, 'fax1AddressType')],
			['fax1EmailAddress', this.#string(mutable, 'fax1EmailAddress')],
			['fax1OriginalDisplayName', this.#string(mutable, 'fax1OriginalDisplayName')],
			['fax2AddressType', this.#string(mutable, 'fax2AddressType')],
			['fax2EmailAddress', this.#string(mutable, 'fax2EmailAddress')],
			['fax2OriginalDisplayName', this.#string(mutable, 'fax2OriginalDisplayName')],
			['fax3AddressType', this.#string(mutable, 'fax3AddressType')],
			['fax3EmailAddress', this.#string(mutable, 'fax3EmailAddress')],
			['fax3OriginalDisplayName', this.#string(mutable, 'fax3OriginalDisplayName')],
		] satisfies ReadonlyArray<
			{ [K in keyof MSGFieldData]-?: readonly [K, MSGFieldData[K]] }[keyof MSGFieldData]
		>

		const fields: MSGFieldData = { category: mutable.category }
		for (const [key, value] of entries) {
			if (value !== undefined) Object.assign(fields, { [key]: value })
		}
		return fields
	}

	#processDirectory(
		entry: MSGDirectoryEntry,
		fields: MSGMutableFieldData,
		headerSize: number,
	): void {
		const children = entry.children
		if (children === undefined) return

		// Process sub-folders first
		for (const childIndex of children.values()) {
			if (childIndex === undefined) continue
			const child = this.#properties[childIndex]
			if (child === undefined) continue

			if (child.category === MSG_CATEGORY_DIRECTORY) {
				this.#processSubDirectory(child, childIndex, fields)
			}
		}

		// Process document streams
		for (const childIndex of children.values()) {
			if (childIndex === undefined) continue
			const child = this.#properties[childIndex]
			if (child === undefined) continue

			if (child.category === MSG_CATEGORY_DOCUMENT) {
				if (child.name.indexOf(MSG_PREFIX_DOCUMENT) === 0) {
					this.#processDocument(child, childIndex, fields)
				} else if (child.name === '__properties_version1.0') {
					this.#processPropertyStream(child, headerSize, fields)
				}
			}
		}
	}

	#processSubDirectory(
		child: MSGDirectoryEntry,
		childIndex: number,
		fields: MSGMutableFieldData,
	): void {
		if (child.name.indexOf(MSG_PREFIX_ATTACHMENT) === 0) {
			const attachmentField: MSGMutableFieldData = { category: 'attachment' }
			Object.assign(fields, {
				attachments: [...(fields.attachments ?? []), attachmentField],
			})
			this.#processDirectory(child, attachmentField, 8)
		} else if (child.name.indexOf(MSG_PREFIX_RECIPIENT) === 0) {
			const recipientField: MSGMutableFieldData = { category: 'recipient' }
			Object.assign(fields, {
				recipients: [...(fields.recipients ?? []), recipientField],
			})
			this.#processDirectory(child, recipientField, 8)
		} else if (child.name.indexOf(MSG_PREFIX_NAMEID) === 0) {
			this.#processNameIdDirectory(child)
		} else {
			const fieldType = this.#getDirectoryFieldType(child)
			if (fieldType === MSG_FIELD_DIR_TYPE_INNER_MSG) {
				const innerFields: MSGMutableFieldData = {
					category: 'msg',
					attachments: [],
					recipients: [],
				}
				this.#processDirectory(child, innerFields, 8)
				Object.assign(fields, {
					innerMSGContentFields: innerFields,
					innerMSGContent: true,
					folderId: childIndex,
				})
				this.#innerMSGDirectories[childIndex] = child
			}
		}
	}

	#getDirectoryFieldType(entry: MSGDirectoryEntry): string {
		const value = entry.name.substring(12).toLowerCase()
		return value.substring(4, 8)
	}

	#processDocument(
		entry: MSGDirectoryEntry,
		entryIndex: number,
		fields: MSGMutableFieldData,
	): void {
		const value = entry.name.substring(12).toLowerCase()
		const fieldClass = value.substring(0, 4)
		const fieldType = value.substring(4, 8)

		if (fieldClass === MSG_FIELD_CLASS_ATTACHMENT_DATA) {
			Object.assign(fields, {
				dataId: entryIndex,
				contentLength: entry.sizeBlock,
			})
			return
		}

		const bytes = this.#readEntry(entry)
		this.#decodeAndAssign(fieldClass, fieldType, bytes, fields, false)
	}

	#processPropertyStream(
		entry: MSGDirectoryEntry,
		headerSize: number,
		fields: MSGMutableFieldData,
	): void {
		const bytes = this.#readEntry(entry)
		if (bytes.length <= headerSize) return

		const propView = new DataView(
			bytes.buffer,
			bytes.byteOffset + headerSize,
			bytes.length - headerSize,
		)
		const offsets = Array.from({ length: Math.floor(propView.byteLength / 16) }, (_, i) => i * 16)

		for (const offset of offsets) {
			const propertyTag = propView.getUint32(offset, true)
			if (propertyTag === 0) break
			// skip flags (4 bytes)

			const valueBytes = new Uint8Array(bytes.buffer, bytes.byteOffset + headerSize + offset + 8, 8)

			const fieldClass = toHexLower((propertyTag >>> 16) & 0xffff, 4)
			const fieldType = toHexLower(propertyTag & 0xffff, 4)

			this.#decodeAndAssign(fieldClass, fieldType, valueBytes, fields, true)
		}
	}

	#decodeAndAssign(
		fieldClass: string,
		fieldType: string,
		bytes: Uint8Array,
		fields: MSGMutableFieldData,
		insideProps: boolean,
	): void {
		const fullTag = `${fieldClass}${fieldType}`
		const defaultKey = MSG_FIELD_FULL_NAMES[fullTag] ?? MSG_FIELD_NAMES[fieldClass]
		const classValue = parseInt(fieldClass, 16)
		const keyed =
			isFiniteNumber(classValue) && classValue >= 0x8000
				? this.#privatePidToKeyed[classValue]
				: undefined
		const resolved = keyed?.useName
			? keyed.name
			: keyed?.propertySet !== undefined && keyed.propertyLid !== undefined
				? (this.#resolvePidLid(keyed.propertySet, keyed.propertyLid) ?? defaultKey)
				: defaultKey
		const decodeAs = MSG_FIELD_TYPES[fieldType]
		const decoded = this.#decodeValue(decodeAs, bytes)
		const key =
			insideProps && (decodeAs === 'string' || decodeAs === 'unicode' || decodeAs === 'binary')
				? undefined
				: resolved
		const value =
			key === 'recipientRole' && isNumber(decoded)
				? decoded === MSG_MAPI_RECIPIENT_TO
					? ('to' satisfies MSGRecipientRole)
					: decoded === MSG_MAPI_RECIPIENT_CC
						? ('cc' satisfies MSGRecipientRole)
						: decoded === MSG_MAPI_RECIPIENT_BCC
							? ('bcc' satisfies MSGRecipientRole)
							: decoded
				: decoded

		if (key !== undefined) Object.assign(fields, { [key]: value })
	}

	#decodeValue(decodeAs: string | undefined, bytes: Uint8Array): unknown {
		if (decodeAs === 'string') return truncateAtNull(decodeText(bytes, this.#options.encoding))
		if (decodeAs === 'unicode') {
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
			return truncateAtNull(readUTF16String(view, 0, Math.floor(bytes.length / 2)))
		}
		if (decodeAs === 'integer' && bytes.length >= 4) {
			return new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(0, true)
		}
		if (decodeAs === 'boolean' && bytes.length >= 2) {
			return new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint16(0, true) !== 0
		}
		if (decodeAs === 'time' && bytes.length >= 8) {
			const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
			return fileTimeToUTCString(view.getUint32(0, true), view.getUint32(4, true))
		}
		return bytes
	}

	#resolvePidLid(propertySet: string, propertyLid: number): string | undefined {
		const propertyNames = MSG_PIDLIDS[propertySet]
		if (propertyNames === undefined) return undefined
		return propertyNames[propertyLid]
	}

	// === Named Property ID Resolution (__nameid_version1.0)

	#processNameIdDirectory(dirEntry: MSGDirectoryEntry): void {
		const children = dirEntry.children
		if (children === undefined) return

		const tables: Array<readonly [string, Uint8Array]> = []

		for (const childIndex of children.values()) {
			if (childIndex === undefined) continue
			const child = this.#properties[childIndex]
			if (child === undefined || child.category !== MSG_CATEGORY_DOCUMENT) continue
			if (child.name.indexOf(MSG_PREFIX_DOCUMENT) !== 0) continue

			const value = child.name.substring(12).toLowerCase()
			const fieldClass = value.substring(0, 4)
			const fieldType = value.substring(4, 8)

			if (fieldClass === '0002' && fieldType === '0102') {
				tables.push(['guid', this.#readEntry(child)])
			} else if (fieldClass === '0003' && fieldType === '0102') {
				tables.push(['entry', this.#readEntry(child)])
			} else if (fieldClass === '0004' && fieldType === '0102') {
				tables.push(['string', this.#readEntry(child)])
			}
		}

		const lookup = new Map(tables)
		const guidTable = lookup.get('guid')
		const entryTable = lookup.get('entry')
		const stringTable = lookup.get('string')
		if (guidTable === undefined || entryTable === undefined || stringTable === undefined) return

		this.#parseEntryStream(entryTable, guidTable, stringTable)
	}

	#parseEntryStream(entryTable: Uint8Array, guidTable: Uint8Array, stringTable: Uint8Array): void {
		const view = new DataView(entryTable.buffer, entryTable.byteOffset, entryTable.length)
		const entryCount = Math.floor(entryTable.length / 8)

		for (const i of Array.from({ length: entryCount }, (_, index) => index)) {
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
						const name = readUTF16String(strView, strOffset + 4, charCount)
						this.#privatePidToKeyed[0x8000 | propertyIndex] = {
							useName: true,
							name,
						}
					}
				}
			} else {
				const guidOffset = 16 * (guidIndex - 3)
				const propertySet =
					guidIndex === 1
						? '00020328-0000-0000-c000-000000000046'
						: guidIndex === 2
							? '00020329-0000-0000-c000-000000000046'
							: guidOffset >= 0 && guidOffset + 16 <= guidTable.length
								? readMicrosoftUUID(guidTable, guidOffset)
								: undefined

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

	// === Burner Entry Assembly (CFB reconstitution for top-level burn and embedded MSG)

	#burnFolder(
		folder: MSGDirectoryEntry,
		padTopLevelPropertyStream: boolean,
		includeRootNameId: boolean,
	): Uint8Array {
		const entries: MSGBurnerEntry[] = [
			{
				name: 'Root Entry',
				category: MSG_CATEGORY_ROOT,
				children: [],
				length: 0,
			},
		]
		this.#registerBurnerFolder(entries, 0, folder, padTopLevelPropertyStream, includeRootNameId)
		return burnCFB(entries)
	}

	#registerBurnerFolder(
		entries: MSGBurnerEntry[],
		parentIndex: number,
		folder: MSGDirectoryEntry,
		padPropertyStream: boolean,
		includeRootNameId: boolean,
	): void {
		const children = folder.children
		if (children === undefined) return

		const parent = entries[parentIndex]
		if (parent === undefined) {
			throw new MSGError('BURN', 'Burner parent index is out of range', { parentIndex })
		}
		if (parent.children === undefined) return

		// Register document streams
		for (const childIndex of children.values()) {
			if (childIndex === undefined) continue
			const child = this.#properties[childIndex]
			if (child === undefined || child.category !== MSG_CATEGORY_DOCUMENT) continue

			const original = this.#readEntry.bind(this, child)
			const size = child.sizeBlock
			const padded = padPropertyStream && child.name === '__properties_version1.0'
			const provider = padded ? this.#readPaddedEntry.bind(this, child) : original
			const length = padded ? size + 8 : size

			this.#appendBurnerEntry(entries, parentIndex, {
				name: child.name,
				category: MSG_CATEGORY_DOCUMENT,
				binaryProvider: provider,
				length,
			})
		}

		// Include root __nameid_version1.0 when rebuilding an embedded MSG as a
		// standalone file, because the embedded storage does not carry it itself.
		if (includeRootNameId) {
			const rootProp = this.#properties[0]
			if (rootProp !== undefined && rootProp.children !== undefined) {
				for (const rootChildIndex of rootProp.children.values()) {
					if (rootChildIndex === undefined) continue
					const rootChild = this.#properties[rootChildIndex]
					if (
						rootChild !== undefined &&
						rootChild.category === MSG_CATEGORY_DIRECTORY &&
						rootChild.name === MSG_PREFIX_NAMEID
					) {
						const subIndex = this.#appendBurnerEntry(entries, parentIndex, {
							name: rootChild.name,
							category: MSG_CATEGORY_DIRECTORY,
							children: [],
							length: 0,
						})
						this.#registerBurnerFolder(entries, subIndex, rootChild, false, false)
					}
				}
			}
		}

		// Register sub-directories
		for (const childIndex of children.values()) {
			if (childIndex === undefined) continue
			const child = this.#properties[childIndex]
			if (child === undefined || child.category !== MSG_CATEGORY_DIRECTORY) continue

			const subIndex = this.#appendBurnerEntry(entries, parentIndex, {
				name: child.name,
				category: MSG_CATEGORY_DIRECTORY,
				children: [],
				length: 0,
			})
			this.#registerBurnerFolder(entries, subIndex, child, false, false)
		}
	}

	#readPaddedEntry(entry: MSGDirectoryEntry): Uint8Array {
		const source = this.#readEntry(entry)
		const target = new Uint8Array(source.length + 8)
		target.set(source.subarray(0, 24), 0)
		target.set(source.subarray(24), 32)
		return target
	}

	#appendBurnerEntry(
		entries: MSGBurnerEntry[],
		parentIndex: number,
		entry: MSGBurnerEntry,
	): number {
		const parent = entries[parentIndex]
		if (parent === undefined || parent.children === undefined) {
			throw new MSGError('BURN', 'Burner parent index is out of range', { parentIndex })
		}
		const index = entries.length
		entries[parentIndex] = {
			...parent,
			children: [...parent.children, index],
		}
		entries.push(entry)
		return index
	}
}
