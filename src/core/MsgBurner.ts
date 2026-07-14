/**
 * MsgBurner
 *
 * Reconstitutes a valid CFB (Compound Binary File) from a flat list
 * of MsgBurnerEntry descriptors. Used to extract embedded .msg
 * attachments as standalone binary files.
 */

import type { MsgBurnerInterface, MsgBurnerEntry, MsgBurnerLiteEntry } from './types.js'
import {
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
import { sectorsNeeded, compareCfbName } from './helpers.js'
import { MsgError } from './errors.js'

// === MsgBurner

/**
 * Reconstitutes a valid CFB (Compound Binary File) from a flat list of
 * {@link MsgBurnerEntry} descriptors — root storage at index 0, its
 * children reachable through `children` indices.
 *
 * @remarks
 * Builds a red-black directory tree, allocates FAT/mini-FAT/DIFAT
 * sectors, then writes the header, directory entries, and stream data
 * into a single binary. Used to extract embedded `.msg` attachments as
 * standalone CFB files.
 */
export class MsgBurner implements MsgBurnerInterface {
	#liteEntries: MsgBurnerLiteEntry[] = []
	#fat: number[] = []
	#miniFat: number[] = []

	/**
	 * Burn a flat list of CFB entries into a valid compound binary file.
	 *
	 * @param entries - Flat entry list starting with Root Entry at index 0
	 * @returns Complete CFB binary as Uint8Array
	 * @throws {@link MsgError} with code `BURN` when an entry name exceeds
	 * the {@link MSG_BURNER_NAME_MAX} UTF-16 code unit limit the CFB directory entry format allows
	 */
	burn(entries: readonly MsgBurnerEntry[]): Uint8Array {
		this.#liteEntries = entries.map((entry) => ({
			entry,
			left: -1,
			right: -1,
			child: -1,
			firstSector: 0,
			mini: entry.type === MSG_TYPE_DOCUMENT && entry.length < MSG_BURNER_MINI_STREAM_CUTOFF,
			red: false,
		}))
		this.#fat = []
		this.#miniFat = []

		this.#buildTree(0)

		// Allocate directory sectors
		const dirSectorCount = sectorsNeeded(
			MSG_BURNER_DIR_ENTRY_SIZE * this.#liteEntries.length,
			MSG_BURNER_SECTOR_SIZE,
		)
		const entriesFirstSector = this.#allocateFat(dirSectorCount)

		// Allocate large document streams
		for (let i = 0; i < this.#liteEntries.length; i++) {
			const le = this.#liteEntries[i]
			if (le.entry.type === MSG_TYPE_DOCUMENT && !le.mini) {
				le.firstSector =
					le.entry.length === 0
						? MSG_END_OF_CHAIN
						: this.#allocateFat(sectorsNeeded(le.entry.length, MSG_BURNER_SECTOR_SIZE))
			}
		}

		// Allocate mini-stream document streams
		for (let i = 0; i < this.#liteEntries.length; i++) {
			const le = this.#liteEntries[i]
			if (le.entry.type === MSG_TYPE_DOCUMENT && le.mini) {
				le.firstSector =
					le.entry.length === 0
						? MSG_END_OF_CHAIN
						: this.#allocateMiniFat(sectorsNeeded(le.entry.length, MSG_BURNER_MINI_SECTOR_SIZE))
			}
		}

		// Allocate mini-FAT sectors
		const numMiniFatSectors = sectorsNeeded(4 * this.#miniFat.length, MSG_BURNER_SECTOR_SIZE)
		const firstMiniFatSector =
			numMiniFatSectors !== 0 ? this.#allocateFat(numMiniFatSectors) : MSG_END_OF_CHAIN

		// Allocate mini-stream data sectors (root entry body)
		const bytesMiniFat = MSG_BURNER_MINI_SECTOR_SIZE * this.#miniFat.length
		const firstMiniDataSector =
			bytesMiniFat > 0
				? this.#allocateFat(sectorsNeeded(bytesMiniFat, MSG_BURNER_SECTOR_SIZE))
				: MSG_END_OF_CHAIN

		this.#liteEntries[0].firstSector =
			firstMiniDataSector === MSG_END_OF_CHAIN ? MSG_END_OF_CHAIN : firstMiniDataSector

		// Allocate FAT sectors (self-referencing)
		const estimatedFatSectors = Math.max(
			1,
			sectorsNeeded(
				4 * (this.#fat.length + Math.ceil(this.#fat.length / MSG_BURNER_INTS_PER_SECTOR) + 1),
				MSG_BURNER_SECTOR_SIZE,
			),
		)
		const firstFatSector = this.#allocateFatAs(estimatedFatSectors, MSG_BURNER_FAT_SECTOR_MARKER)
		const numFatSectors = this.#fat.length - firstFatSector

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
				? this.#allocateFatAs(numDifatSectors, MSG_BURNER_DIFAT_SECTOR_MARKER)
				: MSG_END_OF_CHAIN

		// Build the binary
		const totalSize = MSG_BURNER_SECTOR_SIZE * (1 + this.#fat.length)
		const buffer = new ArrayBuffer(totalSize)
		const view = new DataView(buffer)
		const bytes = new Uint8Array(buffer)

		// Pad mini-FAT to sector boundary
		while (this.#miniFat.length % MSG_BURNER_INTS_PER_SECTOR !== 0) {
			this.#miniFat.push(MSG_UNUSED_BLOCK)
		}

		// Build DIFAT arrays
		const difat1: number[] = []
		const difat2: number[] = []
		this.#buildDifat(difat1, difat2, numFatSectors, firstFatSector, firstDifatSector)

		this.#writeHeader(
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
		this.#writeDirectoryEntries(view, bytes, entriesFirstSector, bytesMiniFat)
		this.#writeLargeStreams(bytes)
		this.#writeMiniStreams(bytes, firstMiniDataSector)
		this.#writeMiniFat(view, firstMiniFatSector)
		this.#writeFat(view, firstFatSector)
		this.#writeDifat(view, difat2, firstDifatSector, numDifatSectors)

		return new Uint8Array(buffer)
	}

	// === FAT Allocation

	#allocateFat(count: number): number {
		const first = this.#fat.length
		for (let i = 0; i < count; i++) {
			const next = i + 1 === count ? MSG_END_OF_CHAIN : first + i + 1
			this.#fat.push(next)
		}
		return first
	}

	#allocateFatAs(count: number, value: number): number {
		const first = this.#fat.length
		for (let i = 0; i < count; i++) {
			this.#fat.push(value)
		}
		return first
	}

	#allocateMiniFat(count: number): number {
		const first = this.#miniFat.length
		for (let i = 0; i < count; i++) {
			const next = i + 1 === count ? MSG_END_OF_CHAIN : first + i + 1
			this.#miniFat.push(next)
		}
		return first
	}

	// === Red-Black Tree Builder

	#buildTree(dirIndex: number): void {
		const liteEntry = this.#liteEntries[dirIndex]
		const children = liteEntry.entry.children
		if (children === undefined || children.length === 0) return

		const sorted = children
			.slice()
			.sort((a, b) =>
				compareCfbName(this.#liteEntries[a].entry.name, this.#liteEntries[b].entry.name),
			)

		const mid = Math.floor(sorted.length / 2)
		const rootIndex = sorted[mid]
		const rootEntry = this.#liteEntries[rootIndex]
		rootEntry.red = false
		rootEntry.left = this.#splitTree(sorted, 0, mid, true)
		rootEntry.right = this.#splitTree(sorted, mid + 1, sorted.length, true)
		liteEntry.child = rootIndex

		for (let i = 0; i < sorted.length; i++) {
			const idx = sorted[i]
			if (this.#liteEntries[idx].entry.type === MSG_TYPE_DIRECTORY) {
				this.#buildTree(idx)
			}
		}
	}

	#splitTree(sorted: number[], start: number, end: number, red: boolean): number {
		if (start >= end) return -1
		const mid = Math.floor((start + end) / 2)
		const entryIndex = sorted[mid]
		const entry = this.#liteEntries[entryIndex]
		entry.red = red
		entry.left = this.#splitTree(sorted, start, mid, !red)
		entry.right = this.#splitTree(sorted, mid + 1, end, !red)
		return entryIndex
	}

	// === DIFAT Builder

	#buildDifat(
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

	// === Binary Writers

	#writeHeader(
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

	#writeDirectoryEntries(
		view: DataView,
		bytes: Uint8Array,
		entriesFirstSector: number,
		bytesMiniFat: number,
	): void {
		for (let x = 0; x < this.#liteEntries.length; x++) {
			const le = this.#liteEntries[x]
			const pos = MSG_BURNER_SECTOR_SIZE * (1 + entriesFirstSector) + MSG_BURNER_DIR_ENTRY_SIZE * x

			// CFB caps a directory entry name at MSG_BURNER_NAME_MAX UTF-16 code
			// units + a NUL terminator inside the fixed 64-byte name field
			// (offsets 0x00-0x3f). A longer name would overrun into the
			// type/color/sibling fields that follow, so validate before
			// writing any name bytes.
			const name = le.entry.name
			if (name.length > MSG_BURNER_NAME_MAX) {
				throw new MsgError(
					'BURN',
					`directory entry name exceeds ${MSG_BURNER_NAME_MAX} characters`,
					{ name },
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

	#writeLargeStreams(bytes: Uint8Array): void {
		for (let i = 0; i < this.#liteEntries.length; i++) {
			const le = this.#liteEntries[i]
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

	#writeMiniStreams(bytes: Uint8Array, firstMiniDataSector: number): void {
		if (firstMiniDataSector === MSG_END_OF_CHAIN) return

		for (let i = 0; i < this.#liteEntries.length; i++) {
			const le = this.#liteEntries[i]
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

	#writeMiniFat(view: DataView, firstMiniFatSector: number): void {
		if (firstMiniFatSector === MSG_END_OF_CHAIN) return

		let offset = MSG_BURNER_SECTOR_SIZE * (1 + firstMiniFatSector)
		for (let i = 0; i < this.#miniFat.length; i++) {
			view.setInt32(offset, this.#miniFat[i], true)
			offset += 4
		}
	}

	#writeFat(view: DataView, firstFatSector: number): void {
		while (this.#fat.length % MSG_BURNER_INTS_PER_SECTOR !== 0) {
			this.#fat.push(MSG_UNUSED_BLOCK)
		}

		let offset = MSG_BURNER_SECTOR_SIZE * (1 + firstFatSector)
		for (let i = 0; i < this.#fat.length; i++) {
			view.setInt32(offset, this.#fat[i], true)
			offset += 4
		}
	}

	#writeDifat(
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
}
