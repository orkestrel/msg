import type {
	EmailAttachment,
	EmailMessage,
	MIMEPart,
	MSGBurnerEntry,
	MSGBurnerLiteEntry,
	MSGSourceInterface,
} from './types.js'
import {
	FALLBACK_ATTACHMENT_NAME,
	MSG_BURNER_DIFAT_HEADER_SLOTS,
	MSG_BURNER_DIFAT_SECTOR_MARKER,
	MSG_BURNER_DIR_ENTRY_SIZE,
	MSG_BURNER_FAT_SECTOR_MARKER,
	MSG_BURNER_INTS_PER_SECTOR,
	MSG_BURNER_MINI_SECTOR_SIZE,
	MSG_BURNER_MINI_STREAM_CUTOFF,
	MSG_BURNER_NAME_MAX,
	MSG_BURNER_ROOT_CLSID,
	MSG_BURNER_SECTOR_SIZE,
	MSG_CATEGORY_DIRECTORY,
	MSG_CATEGORY_DOCUMENT,
	MSG_END_OF_CHAIN,
	MSG_FILE_HEADER,
	MSG_UNUSED_BLOCK,
} from './constants.js'
import { MSGError } from './errors.js'
import {
	compareCFBName,
	decodeMIMEEncoding,
	decodeMIMEText,
	decodeMIMEWords,
	computeSectors,
	formatEmailAddress,
} from './helpers.js'

/**
 * Reconstitutes a valid CFB (Compound Binary File) from a flat list of
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
 * @throws {@link MSGError} with code `BURN` when the entry graph is invalid
 * or an entry name exceeds the {@link MSG_BURNER_NAME_MAX} UTF-16 code unit limit
 */
export function burnCFB(entries: readonly MSGBurnerEntry[]): Uint8Array {
	const liteEntries: MSGBurnerLiteEntry[] = entries.map((entry) => ({
		entry,
		left: -1,
		right: -1,
		child: -1,
		firstSector: 0,
		mini: entry.category === MSG_CATEGORY_DOCUMENT && entry.length < MSG_BURNER_MINI_STREAM_CUTOFF,
		red: false,
	}))
	if (liteEntries[0] === undefined) {
		throw new MSGError('BURN', 'Burner entry list must contain a root entry')
	}

	const directories = [0]
	const owners: Array<number | undefined> = []
	owners[0] = 0
	while (directories.length > 0) {
		const directoryIndex = directories.pop()
		if (directoryIndex === undefined) break
		const directory = liteEntries[directoryIndex]
		if (directory === undefined) {
			throw new MSGError('BURN', 'Directory entry index is out of range', { directoryIndex })
		}
		const children = directory.entry.children
		if (children === undefined || children.length === 0) continue

		for (const childIndex of children) {
			if (!Number.isInteger(childIndex) || childIndex < 0 || childIndex >= liteEntries.length) {
				throw new MSGError('BURN', 'Child entry index is out of range', { childIndex })
			}
			const owner = owners[childIndex]
			if (owner !== undefined) {
				throw new MSGError('BURN', 'Directory entry has multiple parents or forms a cycle', {
					childIndex,
					owner,
					directoryIndex,
				})
			}
			owners[childIndex] = directoryIndex
		}

		const sorted = children.slice().sort((leftIndex, rightIndex) => {
			const left = liteEntries[leftIndex]
			const right = liteEntries[rightIndex]
			if (left === undefined || right === undefined) {
				throw new MSGError('BURN', 'Child entry index is out of range', {
					left: leftIndex,
					right: rightIndex,
				})
			}
			return compareCFBName(left.entry.name, right.entry.name)
		})
		const middle = Math.floor((sorted.length - 1) / 2)
		const rootIndex = sorted[middle]
		if (rootIndex === undefined) {
			throw new MSGError('BURN', 'Directory entry has no tree root', { directoryIndex })
		}
		const root = liteEntries[rootIndex]
		if (root === undefined) {
			throw new MSGError('BURN', 'Child entry index is out of range', { rootIndex })
		}
		let redLevel = 0
		for (
			let remaining = sorted.length - 1;
			remaining >= 0;
			remaining = Math.floor(remaining / 2) - 1
		) {
			redLevel++
		}
		liteEntries[rootIndex] = { ...root, red: false }
		liteEntries[directoryIndex] = { ...directory, child: rootIndex }

		const branches: Array<{
			readonly start: number
			readonly end: number
			readonly parent: number
			readonly left: boolean
			readonly depth: number
		}> = [
			{ start: 0, end: middle, parent: rootIndex, left: true, depth: 1 },
			{
				start: middle + 1,
				end: sorted.length,
				parent: rootIndex,
				left: false,
				depth: 1,
			},
		]
		while (branches.length > 0) {
			const branch = branches.pop()
			if (branch === undefined || branch.start >= branch.end) continue
			const branchMiddle = Math.floor((branch.start + branch.end - 1) / 2)
			const entryIndex = sorted[branchMiddle]
			if (entryIndex === undefined) {
				throw new MSGError('BURN', 'Directory tree contains an empty entry index')
			}
			const entry = liteEntries[entryIndex]
			const parent = liteEntries[branch.parent]
			if (entry === undefined || parent === undefined) {
				throw new MSGError('BURN', 'Directory entry index is out of range', {
					entryIndex,
					parent: branch.parent,
				})
			}
			liteEntries[entryIndex] = { ...entry, red: branch.depth === redLevel }
			liteEntries[branch.parent] = branch.left
				? { ...parent, left: entryIndex }
				: { ...parent, right: entryIndex }
			branches.push(
				{
					start: branch.start,
					end: branchMiddle,
					parent: entryIndex,
					left: true,
					depth: branch.depth + 1,
				},
				{
					start: branchMiddle + 1,
					end: branch.end,
					parent: entryIndex,
					left: false,
					depth: branch.depth + 1,
				},
			)
		}

		for (const childIndex of sorted) {
			const child = liteEntries[childIndex]
			if (child === undefined) {
				throw new MSGError('BURN', 'Child entry index is out of range', { childIndex })
			}
			if (child.entry.category === MSG_CATEGORY_DIRECTORY) directories.push(childIndex)
		}
	}

	const fat: number[] = []
	const miniFat: number[] = []

	const directoryCount = computeSectors(
		MSG_BURNER_DIR_ENTRY_SIZE * liteEntries.length,
		MSG_BURNER_SECTOR_SIZE,
	)
	const entriesFirstSector = fat.length
	for (let index = 0; index < directoryCount; index++) {
		const next = index + 1 === directoryCount ? MSG_END_OF_CHAIN : entriesFirstSector + index + 1
		fat.push(next)
	}

	for (const [index, liteEntry] of liteEntries.entries()) {
		if (liteEntry.entry.category !== MSG_CATEGORY_DOCUMENT || liteEntry.mini) continue
		let firstSector = MSG_END_OF_CHAIN
		if (liteEntry.entry.length !== 0) {
			const count = computeSectors(liteEntry.entry.length, MSG_BURNER_SECTOR_SIZE)
			firstSector = fat.length
			for (let offset = 0; offset < count; offset++) {
				const next = offset + 1 === count ? MSG_END_OF_CHAIN : firstSector + offset + 1
				fat.push(next)
			}
		}
		liteEntries[index] = { ...liteEntry, firstSector }
	}

	for (const [index, liteEntry] of liteEntries.entries()) {
		if (liteEntry.entry.category !== MSG_CATEGORY_DOCUMENT || !liteEntry.mini) continue
		let firstSector = MSG_END_OF_CHAIN
		if (liteEntry.entry.length !== 0) {
			const count = computeSectors(liteEntry.entry.length, MSG_BURNER_MINI_SECTOR_SIZE)
			firstSector = miniFat.length
			for (let offset = 0; offset < count; offset++) {
				const next = offset + 1 === count ? MSG_END_OF_CHAIN : firstSector + offset + 1
				miniFat.push(next)
			}
		}
		liteEntries[index] = { ...liteEntry, firstSector }
	}

	const numMiniFatSectors = computeSectors(4 * miniFat.length, MSG_BURNER_SECTOR_SIZE)
	const firstMiniFatSector = numMiniFatSectors === 0 ? MSG_END_OF_CHAIN : fat.length
	for (let index = 0; index < numMiniFatSectors; index++) {
		const next = index + 1 === numMiniFatSectors ? MSG_END_OF_CHAIN : firstMiniFatSector + index + 1
		fat.push(next)
	}

	const bytesMiniFat = MSG_BURNER_MINI_SECTOR_SIZE * miniFat.length
	const miniDataCount = bytesMiniFat === 0 ? 0 : computeSectors(bytesMiniFat, MSG_BURNER_SECTOR_SIZE)
	const firstMiniDataSector = miniDataCount === 0 ? MSG_END_OF_CHAIN : fat.length
	for (let index = 0; index < miniDataCount; index++) {
		const next = index + 1 === miniDataCount ? MSG_END_OF_CHAIN : firstMiniDataSector + index + 1
		fat.push(next)
	}

	const rootLiteEntry = liteEntries[0]
	if (rootLiteEntry === undefined) {
		throw new MSGError('BURN', 'Burner entry list must contain a root entry')
	}
	liteEntries[0] = {
		...rootLiteEntry,
		firstSector: firstMiniDataSector === MSG_END_OF_CHAIN ? MSG_END_OF_CHAIN : firstMiniDataSector,
	}

	let numFatSectors = 0
	let numDifatSectors = 0
	for (;;) {
		const nextFatSectors = computeSectors(
			4 * (fat.length + numFatSectors + numDifatSectors),
			MSG_BURNER_SECTOR_SIZE,
		)
		const nextDifatSectors =
			nextFatSectors > MSG_BURNER_DIFAT_HEADER_SLOTS
				? Math.ceil((nextFatSectors - MSG_BURNER_DIFAT_HEADER_SLOTS) / 127)
				: 0
		if (nextFatSectors === numFatSectors && nextDifatSectors === numDifatSectors) break
		numFatSectors = nextFatSectors
		numDifatSectors = nextDifatSectors
	}
	const firstFatSector = fat.length
	for (let index = 0; index < numFatSectors; index++) {
		fat.push(MSG_BURNER_FAT_SECTOR_MARKER)
	}
	const firstDifatSector = numDifatSectors === 0 ? MSG_END_OF_CHAIN : fat.length
	for (let index = 0; index < numDifatSectors; index++) {
		fat.push(MSG_BURNER_DIFAT_SECTOR_MARKER)
	}

	const totalSize = MSG_BURNER_SECTOR_SIZE * (1 + fat.length)
	const buffer = new ArrayBuffer(totalSize)
	const view = new DataView(buffer)
	const bytes = new Uint8Array(buffer)

	while (miniFat.length % MSG_BURNER_INTS_PER_SECTOR !== 0) {
		miniFat.push(MSG_UNUSED_BLOCK)
	}

	const headerDifat: number[] = []
	const sectorDifat: number[] = []
	let fatIndex = 0
	for (; fatIndex < MSG_BURNER_DIFAT_HEADER_SLOTS && fatIndex < numFatSectors; fatIndex++) {
		headerDifat.push(firstFatSector + fatIndex)
	}
	let nextDifatSector = firstDifatSector + 1
	for (; fatIndex < numFatSectors; fatIndex++) {
		sectorDifat.push(firstFatSector + fatIndex)
		if ((sectorDifat.length & 127) === 127) {
			const continued = fatIndex + 1 < numFatSectors
			sectorDifat.push(continued ? nextDifatSector : MSG_END_OF_CHAIN)
			if (continued) nextDifatSector++
		}
	}
	while (sectorDifat.length > 0 && (sectorDifat.length & 127) !== 0) {
		const remain = sectorDifat.length & 127
		sectorDifat.push(remain === 127 ? MSG_END_OF_CHAIN : MSG_UNUSED_BLOCK)
	}

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

	let headerOffset = 0x4c
	for (const sector of headerDifat) {
		view.setInt32(headerOffset, sector, true)
		headerOffset += 4
	}
	for (let index = headerDifat.length; index < MSG_BURNER_DIFAT_HEADER_SLOTS; index++) {
		view.setInt32(headerOffset, MSG_UNUSED_BLOCK, true)
		headerOffset += 4
	}

	for (const [index, liteEntry] of liteEntries.entries()) {
		const position =
			MSG_BURNER_SECTOR_SIZE * (1 + entriesFirstSector) + MSG_BURNER_DIR_ENTRY_SIZE * index
		const name = liteEntry.entry.name
		if (name.length > MSG_BURNER_NAME_MAX) {
			throw new MSGError('BURN', `directory entry name exceeds ${MSG_BURNER_NAME_MAX} characters`, {
				name,
			})
		}
		for (let offset = 0; offset < name.length; offset++) {
			view.setUint16(position + offset * 2, name.charCodeAt(offset), true)
		}
		view.setUint16(position + name.length * 2, 0, true)
		view.setUint16(position + 0x40, (name.length + 1) * 2, true)
		bytes[position + 0x42] = liteEntry.entry.category
		bytes[position + 0x43] = liteEntry.red ? 0 : 1
		view.setInt32(position + 0x44, liteEntry.left, true)
		view.setInt32(position + 0x48, liteEntry.right, true)
		view.setInt32(position + 0x4c, liteEntry.child, true)
		if (index === 0) bytes.set(MSG_BURNER_ROOT_CLSID, position + 0x50)

		const length = index === 0 ? bytesMiniFat : liteEntry.entry.length
		const firstSector =
			length !== 0
				? liteEntry.firstSector
				: liteEntry.entry.category === MSG_CATEGORY_DIRECTORY
					? 0
					: MSG_END_OF_CHAIN
		view.setInt32(position + 0x74, firstSector, true)
		view.setInt32(position + 0x78, length, true)
	}

	for (const liteEntry of liteEntries) {
		if (
			liteEntry.entry.category === MSG_CATEGORY_DOCUMENT &&
			!liteEntry.mini &&
			liteEntry.entry.binaryProvider !== undefined
		) {
			const stream = liteEntry.entry.binaryProvider()
			bytes.set(stream, MSG_BURNER_SECTOR_SIZE * (1 + liteEntry.firstSector))
		}
	}

	if (firstMiniDataSector !== MSG_END_OF_CHAIN) {
		for (const liteEntry of liteEntries) {
			if (
				liteEntry.entry.category === MSG_CATEGORY_DOCUMENT &&
				liteEntry.mini &&
				liteEntry.entry.binaryProvider !== undefined
			) {
				const stream = liteEntry.entry.binaryProvider()
				bytes.set(
					stream,
					MSG_BURNER_SECTOR_SIZE * (1 + firstMiniDataSector) +
						MSG_BURNER_MINI_SECTOR_SIZE * liteEntry.firstSector,
				)
			}
		}
	}

	if (firstMiniFatSector !== MSG_END_OF_CHAIN) {
		let miniFatOffset = MSG_BURNER_SECTOR_SIZE * (1 + firstMiniFatSector)
		for (const sector of miniFat) {
			view.setInt32(miniFatOffset, sector, true)
			miniFatOffset += 4
		}
	}

	while (fat.length % MSG_BURNER_INTS_PER_SECTOR !== 0) {
		fat.push(MSG_UNUSED_BLOCK)
	}
	let fatOffset = MSG_BURNER_SECTOR_SIZE * (1 + firstFatSector)
	for (const sector of fat) {
		view.setInt32(fatOffset, sector, true)
		fatOffset += 4
	}

	if (numDifatSectors > 0) {
		let difatOffset = MSG_BURNER_SECTOR_SIZE * (1 + firstDifatSector)
		for (const sector of sectorDifat) {
			view.setInt32(difatOffset, sector, true)
			difatOffset += 4
		}
	}

	return new Uint8Array(buffer)
}

// === Email Shapers

/**
 * Extracts a single EmailMessage from a parsed MSG source.
 * Reads field data and attachments from the given source.
 *
 * Each attachment is read independently: a corrupt attachment throws
 * from `reader.attachment(i)` is caught and that attachment is skipped
 * so the rest of the message still parses. This containment keeps one
 * damaged attachment stream from failing the entire message extraction.
 *
 * @param reader - A parsed MSG source exposing field data and attachment access
 * @returns Structured EmailMessage
 */
export function extractMessageFromMSG(reader: MSGSourceInterface): EmailMessage {
	const fields = reader.parse()

	const from = formatEmailAddress(fields.senderName, fields.senderSMTPAddress ?? fields.senderEmail)

	const recipients = fields.recipients ?? []
	const to = recipients
		.filter((r) => r.recipientRole === 'to')
		.map((r) => formatEmailAddress(r.name, r.smtpAddress ?? r.email))
		.filter((s) => s.length > 0)
	const cc = recipients
		.filter((r) => r.recipientRole === 'cc')
		.map((r) => formatEmailAddress(r.name, r.smtpAddress ?? r.email))
		.filter((s) => s.length > 0)

	const rawDate = fields.messageDeliveryTime ?? fields.clientSubmitTime
	let date: Date | undefined
	if (rawDate !== undefined) {
		const parsed = new Date(rawDate)
		date = isNaN(parsed.getTime()) ? undefined : parsed
	}

	const attachments: EmailAttachment[] = []
	const attachmentFields = fields.attachments ?? []
	for (let i = 0; i < attachmentFields.length; i++) {
		const attachment = attachmentFields[i]
		if (attachment === undefined) continue
		if (attachment.attachmentHidden === true) continue
		if (attachment.innerMSGContent === true) continue
		try {
			const extracted = reader.attachment(i)
			attachments.push({
				name: extracted.name,
				mimeType: attachment.mimeType ?? 'application/octet-stream',
				bytes: extracted.bytes,
			})
		} catch {
			// A single corrupt attachment stream must not fail the whole message.
			continue
		}
	}

	return {
		from,
		to,
		cc,
		subject: fields.subject ?? '',
		date,
		text: fields.body ?? '',
		html: fields.bodyHTML ?? '',
		attachments,
	}
}

/**
 * Extracts a single EmailMessage from a top-level MIMEPart.
 * Walks the full MIME tree to collect text, HTML, and attachments.
 *
 * @param part - Root MIMEPart from parseMIMEPart
 * @returns Structured EmailMessage
 */
export function extractMessage(part: MIMEPart): EmailMessage {
	const from = decodeMIMEWords(part.headers.get('from')?.value ?? '')
	const recipientValues = ['to', 'cc'].map((name) =>
		decodeMIMEWords(part.headers.get(name)?.value ?? ''),
	)
	const recipients = recipientValues.map((value) =>
		value.length === 0
			? []
			: value
					.split(',')
					.map((address) => address.trim())
					.filter((address) => address.length > 0),
	)
	const to = recipients[0] ?? []
	const cc = recipients[1] ?? []

	const rawDate = part.headers.get('date')?.value
	let date: Date | undefined
	if (rawDate !== undefined) {
		const parsed = new Date(rawDate)
		date = isNaN(parsed.getTime()) ? undefined : parsed
	}

	const collectedText: string[] = []
	const collectedHTML: string[] = []
	const attachments: EmailAttachment[] = []
	const pending = [part]

	while (pending.length > 0) {
		const current = pending.pop()
		if (current === undefined) break
		const contentType = current.headers.get('content-type')
		const disposition = current.headers.get('content-disposition')
		const transferEncoding = current.headers.get('content-transfer-encoding')

		const primaryType = ((contentType?.value ?? 'text/plain').split(';')[0] ?? '')
			.trim()
			.toLowerCase()
		const encoding = (transferEncoding?.value ?? '7bit').trim()
		const charset = contentType?.params.get('charset') ?? 'utf-8'
		const dispositionKind = (disposition?.value ?? '').trim().toLowerCase()

		if (primaryType.startsWith('multipart/')) {
			for (let index = current.parts.length - 1; index >= 0; index--) {
				const child = current.parts[index]
				if (child !== undefined) pending.push(child)
			}
			continue
		}

		const isAttachmentPart = dispositionKind === 'attachment'

		if (isAttachmentPart) {
			const name =
				disposition?.params.get('filename') ??
				contentType?.params.get('name') ??
				FALLBACK_ATTACHMENT_NAME
			const bytes = decodeMIMEEncoding(current.body, encoding)
			attachments.push({
				name: decodeMIMEWords(name),
				mimeType: primaryType,
				bytes,
			})
			continue
		}

		if (primaryType === 'text/plain') {
			collectedText.push(decodeMIMEText(current.body, encoding, charset))
			continue
		}

		if (primaryType === 'text/html') {
			collectedHTML.push(decodeMIMEText(current.body, encoding, charset))
			continue
		}

		// Inline binary parts with a filename become attachments
		const inlineName = contentType?.params.get('name') ?? disposition?.params.get('filename')
		if (inlineName !== undefined) {
			const bytes = decodeMIMEEncoding(current.body, encoding)
			attachments.push({
				name: decodeMIMEWords(inlineName),
				mimeType: primaryType,
				bytes,
			})
		}
	}

	return {
		from,
		to,
		cc,
		subject: decodeMIMEWords(part.headers.get('subject')?.value ?? ''),
		date,
		text: collectedText.join(''),
		html: collectedHTML.join(''),
		attachments,
	}
}
