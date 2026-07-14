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
} from '../types.js'
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
} from '../constants.js'
import {
	isMsgFile,
	removeTrailingNull,
	readUtf16String,
	readAnsiString,
	fileTimeToUtcString,
	toHexLower,
	msftUuidStringify,
} from '../helpers.js'
import { MsgBurner } from './MsgBurner.js'
// === MsgReader

export class MsgReader implements MsgReaderInterface {
	readonly #view: DataView
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

	constructor(buffer: ArrayBuffer, options?: MsgReaderOptions) {
		this.#view = new DataView(buffer)
		this.#options = options ?? {}
	}

	parse(): MsgFieldData {
		if (this.#fields !== undefined) return this.#fields

		if (!isMsgFile(this.#view)) {
			const result: MsgFieldData = { dataType: null, error: 'Unsupported file type' }
			this.#fields = result
			return result
		}

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

	attachment(index: number): MsgAttachment {
		const parsed = this.parse()
		const attachments = parsed.attachments
		if (attachments === undefined || index < 0 || index >= attachments.length) {
			throw new Error(`Attachment index ${index} out of range`)
		}

		const attach = attachments[index]
		if (attach.innerMsgContent === true && typeof attach.folderId === 'number') {
			const name = typeof attach.name === 'string' ? attach.name : 'embedded'
			const burner = this.#innerMsgBurners[attach.folderId]
			const content = burner !== undefined ? burner() : new Uint8Array(0)
			return { fileName: name + '.msg', content }
		}

		if (typeof attach.dataId !== 'number') {
			throw new Error('Attachment has no data reference')
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

	burn(): Uint8Array {
		const parsed = this.parse()
		if (parsed.dataType !== 'msg' || parsed.error !== undefined) {
			throw new Error(parsed.error ?? 'Unable to burn unsupported MSG file')
		}

		const root = this.#properties[0]
		if (root === undefined) {
			throw new Error('Unable to burn MSG file without a root entry')
		}

		return this.#burnFolder(root, false, false)
	}

	// === Header Parsing

	#parseHeader(): void {
		const v = this.#view
		const sectorMark = v.getUint8(30)
		this.#bigBlockSize =
			sectorMark === MSG_L_BIG_BLOCK_MARK ? MSG_L_BIG_BLOCK_SIZE : MSG_S_BIG_BLOCK_SIZE
		this.#bigBlockLength = this.#bigBlockSize / 4
		this.#xBlockLength = this.#bigBlockLength - 1

		this.#batCount = v.getInt32(MSG_HEADER_BAT_COUNT_OFFSET, true)
		this.#propertyStart = v.getInt32(MSG_HEADER_PROPERTY_START_OFFSET, true)
		this.#sbatStart = v.getInt32(MSG_HEADER_SBAT_START_OFFSET, true)
		this.#sbatCount = v.getInt32(MSG_HEADER_SBAT_COUNT_OFFSET, true)
		this.#xbatStart = v.getInt32(MSG_HEADER_XBAT_START_OFFSET, true)
		this.#xbatCount = v.getInt32(MSG_HEADER_XBAT_COUNT_OFFSET, true)
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
		return (sector + 1) * this.#bigBlockSize
	}

	#blockValueAt(sector: number, index: number): number {
		const offset = this.#blockOffset(sector) + 4 * index
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
		let startIndex = this.#sbatStart
		for (
			let i = 0;
			i < this.#sbatCount && startIndex !== 0 && startIndex !== MSG_END_OF_CHAIN;
			i++
		) {
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

		for (let i = 0; i < this.#xbatCount; i++) {
			const blockOffset = this.#blockOffset(nextSector)
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
		const charCount = nameBytes / 2 - 1
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
		let currentSector = propertyStart

		while (currentSector !== MSG_END_OF_CHAIN) {
			const entryCount = this.#bigBlockSize / MSG_PROPERTY_SIZE
			let offset = this.#blockOffset(currentSector)

			for (let i = 0; i < entryCount; i++) {
				if (offset + MSG_PROP_TYPE_OFFSET >= this.#view.byteLength) break
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
			this.#buildHierarchy(props, props[0])
		}
		return props
	}

	#buildHierarchy(props: MsgDirectoryEntry[], node: MsgDirectoryEntry): void {
		if (node === undefined || node.childProperty === MSG_PROP_NO_INDEX) return
		node.children = []

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
					this.#buildHierarchy(props, current)
				}
				if (current.nextProperty !== MSG_PROP_NO_INDEX) {
					stack.push({ mode: 'walk', index: current.nextProperty })
				}
				stack.push({ mode: 'push', index: item.index })
				if (current.previousProperty !== MSG_PROP_NO_INDEX) {
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
		let nextBlock = rootProp.startBlock
		while (nextBlock !== MSG_END_OF_CHAIN) {
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
		let next = entry.startBlock
		while (next !== MSG_END_OF_CHAIN) {
			chain.push(next)
			next = this.#nextBlockSmall(next)
		}
		return chain
	}

	#readEntry(entry: MsgDirectoryEntry): Uint8Array {
		if (!entry.sizeBlock) return new Uint8Array(0)

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

		while (remaining >= 1) {
			const start = this.#blockOffset(nextBlock)
			const partSize = Math.min(remaining, this.#bigBlockSize)
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
		const fields: MsgMutableFieldData = {
			dataType: 'msg',
			attachments: [],
			recipients: [],
		}
		this.#processDirectory(this.#properties[0], fields, 'root')
		return fields as unknown as MsgFieldData
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
			const attachmentField: MsgMutableFieldData = { dataType: 'attachment' }
			if (fields.attachments === undefined) fields.attachments = []
			fields.attachments.push(attachmentField)
			this.#processDirectory(child, attachmentField, 'attachment')
		} else if (child.name.indexOf(MSG_PREFIX_RECIPIENT) === 0) {
			const recipientField: MsgMutableFieldData = { dataType: 'recipient' }
			if (fields.recipients === undefined) fields.recipients = []
			fields.recipients.push(recipientField)
			this.#processDirectory(child, recipientField, 'recip')
		} else if (child.name.indexOf(MSG_PREFIX_NAMEID) === 0) {
			this.#processNameIdDirectory(child)
		} else {
			const fieldType = this.#getDirectoryFieldType(child)
			if (fieldType === MSG_FIELD_DIR_TYPE_INNER_MSG) {
				const innerFields: MsgMutableFieldData = {
					dataType: 'msg',
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

		const classValue = parseInt(`0x${fieldClass}`)
		if (classValue >= 0x8000) {
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
