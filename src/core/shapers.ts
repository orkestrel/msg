import type {
	EmailAttachment,
	EmailMessage,
	MIMEPart,
	MSGBurnerEntry,
	MSGBurnerLiteEntry,
	MSGSourceInterface,
} from './types.js'
import { isNonNegativeInteger } from '@orkestrel/contract'
import {
	FALLBACK_ATTACHMENT_NAME,
	MSG_BURNER_DIFAT_HEADER_SLOTS,
	MSG_BURNER_DIFAT_SECTOR_MARKER,
	MSG_BURNER_FAT_SECTOR_MARKER,
	MSG_BURNER_INTS_PER_SECTOR,
	MSG_BURNER_NAME_MAX,
	MSG_BURNER_ROOT_CLSID,
	MSG_CATEGORY_DIRECTORY,
	MSG_CATEGORY_DOCUMENT,
	MSG_DIRECTORY_ENTRY_SIZE,
	MSG_END_OF_CHAIN,
	MSG_FILE_HEADER,
	MSG_MINI_SECTOR_SIZE,
	MSG_MINI_STREAM_CUTOFF,
	MSG_SECTOR_SIZE,
	MSG_UNUSED_BLOCK,
} from './constants.js'
import { MSGError } from './errors.js'
import {
	compareCFBName,
	computeSectors,
	decodeMIMEEncoding,
	decodeMIMEText,
	decodeMIMEWords,
	formatEmailAddress,
} from './helpers.js'

/**
 * Reconstitutes a valid CFB (Compound Binary File) binary from a flat list of
 * {@link MSGBurnerEntry} descriptors — root storage at index 0, its children reachable through
 * `children` indices.
 *
 * @remarks
 * Builds a red-black directory tree, allocates FAT, mini-FAT, and DIFAT sectors, then writes the
 * header, the directory entries, and the stream data into a single binary. Extracting an embedded
 * `.msg` attachment as a standalone CFB file runs through this path.
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
		mini: entry.category === MSG_CATEGORY_DOCUMENT && entry.length < MSG_MINI_STREAM_CUTOFF,
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
			if (!isNonNegativeInteger(childIndex) || childIndex >= liteEntries.length) {
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
		const redLevel = Math.floor(Math.log2(sorted.length + 1))
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

	const directoryCount = computeSectors(
		MSG_DIRECTORY_ENTRY_SIZE * liteEntries.length,
		MSG_SECTOR_SIZE,
	)
	const entriesFirstSector = 0
	const directoryLinks = Array.from({ length: directoryCount }, (_, index) =>
		index + 1 === directoryCount ? MSG_END_OF_CHAIN : index + 1,
	)
	const largeSteps: Array<{
		readonly entry: MSGBurnerLiteEntry
		readonly end: number
		readonly sectors: readonly number[]
	}> = []
	for (const liteEntry of liteEntries) {
		const start = largeSteps.at(-1)?.end ?? directoryCount
		if (liteEntry.entry.category !== MSG_CATEGORY_DOCUMENT || liteEntry.mini) {
			largeSteps.push({ entry: liteEntry, end: start, sectors: [] })
			continue
		}
		const empty = liteEntry.entry.length === 0
		const count = empty ? 0 : computeSectors(liteEntry.entry.length, MSG_SECTOR_SIZE)
		const sectors = Array.from({ length: count }, (_, offset) =>
			offset + 1 === count ? MSG_END_OF_CHAIN : start + offset + 1,
		)
		largeSteps.push({
			entry: { ...liteEntry, firstSector: empty ? MSG_END_OF_CHAIN : start },
			end: start + count,
			sectors,
		})
	}
	const largeEntries = largeSteps.map((step) => step.entry)
	const dataFat = [...directoryLinks, ...largeSteps.flatMap((step) => step.sectors)]
	const miniSteps: typeof largeSteps = []
	for (const liteEntry of largeEntries) {
		const start = miniSteps.at(-1)?.end ?? 0
		if (liteEntry.entry.category !== MSG_CATEGORY_DOCUMENT || !liteEntry.mini) {
			miniSteps.push({ entry: liteEntry, end: start, sectors: [] })
			continue
		}
		const empty = liteEntry.entry.length === 0
		const count = empty ? 0 : computeSectors(liteEntry.entry.length, MSG_MINI_SECTOR_SIZE)
		const sectors = Array.from({ length: count }, (_, offset) =>
			offset + 1 === count ? MSG_END_OF_CHAIN : start + offset + 1,
		)
		miniSteps.push({
			entry: { ...liteEntry, firstSector: empty ? MSG_END_OF_CHAIN : start },
			end: start + count,
			sectors,
		})
	}
	const miniEntries = miniSteps.map((step) => step.entry)
	const miniLinks = miniSteps.flatMap((step) => step.sectors)
	const numMiniFatSectors = computeSectors(4 * miniLinks.length, MSG_SECTOR_SIZE)
	const firstMiniFatSector = numMiniFatSectors === 0 ? MSG_END_OF_CHAIN : dataFat.length
	const miniFatLinks = Array.from({ length: numMiniFatSectors }, (_, index) =>
		index + 1 === numMiniFatSectors ? MSG_END_OF_CHAIN : firstMiniFatSector + index + 1,
	)
	const bytesMiniFat = MSG_MINI_SECTOR_SIZE * miniLinks.length
	const miniDataCount = bytesMiniFat === 0 ? 0 : computeSectors(bytesMiniFat, MSG_SECTOR_SIZE)
	const firstMiniDataSector =
		miniDataCount === 0 ? MSG_END_OF_CHAIN : dataFat.length + miniFatLinks.length
	const miniDataLinks = Array.from({ length: miniDataCount }, (_, index) =>
		index + 1 === miniDataCount ? MSG_END_OF_CHAIN : firstMiniDataSector + index + 1,
	)
	const rootLiteEntry = miniEntries[0]
	if (rootLiteEntry === undefined) {
		throw new MSGError('BURN', 'Burner entry list must contain a root entry')
	}
	const allocated = miniEntries.map((entry, index) =>
		index === 0 ? { ...rootLiteEntry, firstSector: firstMiniDataSector } : entry,
	)
	const dataLinks = [...dataFat, ...miniFatLinks, ...miniDataLinks]
	const capacity = MSG_BURNER_INTS_PER_SECTOR - 1
	const numDifatSectors = Math.ceil(
		Math.max(0, dataLinks.length - MSG_BURNER_DIFAT_HEADER_SLOTS * capacity) /
			(capacity * capacity - 1),
	)
	const numFatSectors = Math.ceil((dataLinks.length + numDifatSectors) / capacity)
	const firstFatSector = dataLinks.length
	const firstDifatSector =
		numDifatSectors === 0 ? MSG_END_OF_CHAIN : dataLinks.length + numFatSectors
	const fat = [
		...dataLinks,
		...Array.from({ length: numFatSectors }, () => MSG_BURNER_FAT_SECTOR_MARKER),
		...Array.from({ length: numDifatSectors }, () => MSG_BURNER_DIFAT_SECTOR_MARKER),
	]

	const totalSize = MSG_SECTOR_SIZE * (1 + fat.length)
	const buffer = new ArrayBuffer(totalSize)
	const view = new DataView(buffer)
	const bytes = new Uint8Array(buffer)

	const miniFat = Array.from(
		{
			length: Math.ceil(miniLinks.length / MSG_BURNER_INTS_PER_SECTOR) * MSG_BURNER_INTS_PER_SECTOR,
		},
		(_, index) => miniLinks[index] ?? MSG_UNUSED_BLOCK,
	)

	const headerDifat = Array.from(
		{ length: Math.min(MSG_BURNER_DIFAT_HEADER_SLOTS, numFatSectors) },
		(_, index) => firstFatSector + index,
	)
	const sectorDifat = Array.from(
		{ length: numDifatSectors * MSG_BURNER_INTS_PER_SECTOR },
		(_, index) => {
			const sector = Math.floor(index / MSG_BURNER_INTS_PER_SECTOR)
			const offset = index % MSG_BURNER_INTS_PER_SECTOR
			if (offset === capacity) {
				return sector + 1 < numDifatSectors ? firstDifatSector + sector + 1 : MSG_END_OF_CHAIN
			}
			const fatIndex = MSG_BURNER_DIFAT_HEADER_SLOTS + sector * capacity + offset
			return fatIndex < numFatSectors ? firstFatSector + fatIndex : MSG_UNUSED_BLOCK
		},
	)

	bytes.set(MSG_FILE_HEADER, 0)
	view.setUint16(0x18, 0x3e, true)
	view.setUint16(0x1a, 0x03, true)
	view.setUint16(0x1c, 0xfffe, true)
	view.setUint16(0x1e, 9, true)
	view.setUint16(0x20, 6, true)
	view.setInt32(0x2c, numFatSectors, true)
	view.setInt32(0x30, entriesFirstSector, true)
	view.setInt32(0x38, MSG_MINI_STREAM_CUTOFF, true)
	view.setInt32(0x3c, firstMiniFatSector, true)
	view.setInt32(0x40, numMiniFatSectors, true)
	view.setInt32(0x44, firstDifatSector, true)
	view.setInt32(0x48, numDifatSectors, true)

	for (const index of Array.from({ length: MSG_BURNER_DIFAT_HEADER_SLOTS }, (_, i) => i)) {
		view.setInt32(0x4c + index * 4, headerDifat[index] ?? MSG_UNUSED_BLOCK, true)
	}

	for (const [index, liteEntry] of allocated.entries()) {
		const position = MSG_SECTOR_SIZE * (1 + entriesFirstSector) + MSG_DIRECTORY_ENTRY_SIZE * index
		const name = liteEntry.entry.name
		if (name.length > MSG_BURNER_NAME_MAX) {
			throw new MSGError('BURN', `directory entry name exceeds ${MSG_BURNER_NAME_MAX} characters`, {
				name,
			})
		}
		for (const offset of Array.from({ length: name.length }, (_, unit) => unit)) {
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

	for (const liteEntry of allocated) {
		if (
			liteEntry.entry.category === MSG_CATEGORY_DOCUMENT &&
			!liteEntry.mini &&
			liteEntry.entry.binaryProvider !== undefined
		) {
			const stream = liteEntry.entry.binaryProvider()
			bytes.set(stream, MSG_SECTOR_SIZE * (1 + liteEntry.firstSector))
		}
	}

	if (firstMiniDataSector !== MSG_END_OF_CHAIN) {
		for (const liteEntry of allocated) {
			if (
				liteEntry.entry.category === MSG_CATEGORY_DOCUMENT &&
				liteEntry.mini &&
				liteEntry.entry.binaryProvider !== undefined
			) {
				const stream = liteEntry.entry.binaryProvider()
				bytes.set(
					stream,
					MSG_SECTOR_SIZE * (1 + firstMiniDataSector) +
						MSG_MINI_SECTOR_SIZE * liteEntry.firstSector,
				)
			}
		}
	}

	if (firstMiniFatSector !== MSG_END_OF_CHAIN) {
		for (const [index, sector] of miniFat.entries()) {
			view.setInt32(MSG_SECTOR_SIZE * (1 + firstMiniFatSector) + index * 4, sector, true)
		}
	}

	const paddedFat = Array.from(
		{ length: Math.ceil(fat.length / MSG_BURNER_INTS_PER_SECTOR) * MSG_BURNER_INTS_PER_SECTOR },
		(_, index) => fat[index] ?? MSG_UNUSED_BLOCK,
	)
	for (const [index, sector] of paddedFat.entries()) {
		view.setInt32(MSG_SECTOR_SIZE * (1 + firstFatSector) + index * 4, sector, true)
	}

	if (numDifatSectors > 0) {
		for (const [index, sector] of sectorDifat.entries()) {
			view.setInt32(MSG_SECTOR_SIZE * (1 + firstDifatSector) + index * 4, sector, true)
		}
	}

	return new Uint8Array(buffer)
}

// === Email Shapers

/**
 * Extracts one {@link EmailMessage} from the field data and attachments of a parsed MSG source; a
 * corrupt attachment is skipped rather than fatal.
 *
 * @remarks
 * Each attachment is read independently: a throw from the source's `attachment` call is caught and
 * that attachment alone is skipped, so the rest of the message still parses. This containment
 * keeps one damaged attachment stream from failing the whole message extraction.
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
	const parsed = rawDate === undefined ? undefined : new Date(rawDate)
	const date = parsed === undefined || isNaN(parsed.getTime()) ? undefined : parsed

	const attachments: EmailAttachment[] = []
	const attachmentFields = fields.attachments ?? []
	for (const [i, attachment] of attachmentFields.entries()) {
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
 * Extracts one {@link EmailMessage} by walking a parsed {@link MIMEPart} tree for its text, HTML,
 * and attachments.
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
	const parsed = rawDate === undefined ? undefined : new Date(rawDate)
	const date = parsed === undefined || isNaN(parsed.getTime()) ? undefined : parsed

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
			const indices = Array.from(
				{ length: current.parts.length },
				(_, i) => current.parts.length - 1 - i,
			)
			for (const index of indices) {
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
