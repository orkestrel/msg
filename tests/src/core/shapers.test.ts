import { describe, expect, it } from 'vitest'
import type { MSGBurnerEntry } from '@src/core'
import {
	burnCFB,
	isMSGError,
	isMSGFile,
	MSG,
	MSG_BURNER_DIR_ENTRY_SIZE,
	MSG_BURNER_MINI_STREAM_CUTOFF,
	MSG_BURNER_NAME_MAX,
	MSG_BURNER_SECTOR_SIZE,
	MSG_CATEGORY_DIRECTORY,
	MSG_CATEGORY_DOCUMENT,
	MSG_CATEGORY_ROOT,
	MSG_END_OF_CHAIN,
} from '@src/core'
import { captureError, requireValue } from '@orkestrel/test'

// burnCFB reconstitutes a CFB (Compound Binary File) from a flat list of
// MSGBurnerEntry descriptors — root storage at index 0, its children
// reachable through `children` indices. The load-bearing behavior: entries
// below the mini-stream cutoff land in the mini-FAT/mini-stream, entries
// at/above it land in the regular FAT sectors, the directory red-black tree
// is built via compareCFBName (length-first, then case-insensitive)
// ordering, directory entry names are capped at MSG_BURNER_NAME_MAX UTF-16
// units, and every failure surfaces as a typed MSGError (code BURN) — never
// a raw TypeError. Round-trips are verified by re-parsing burned output with
// the real MSG parser (no mocks, per AGENTS §16). These cases are re-homed
// from the retired MSGBurner.test.ts, calling the pure burnCFB shaper
// directly instead of the retired MSGBurner class.

describe('burnCFB — minimal burn', () => {
	it('burns a root-only entry list into a valid CFB file', () => {
		const entries: MSGBurnerEntry[] = [
			{ name: 'Root Entry', category: MSG_CATEGORY_ROOT, children: [], length: 0 },
		]

		const result = burnCFB(entries)
		const view = new DataView(result.buffer, result.byteOffset, result.byteLength)

		expect(isMSGFile(view)).toBe(true)
	})
})

describe('burnCFB — mini-stream cutoff boundary (round-trip)', () => {
	it('burns and round-trips a stream one byte UNDER the cutoff (mini-stream)', () => {
		const payload = new Uint8Array(MSG_BURNER_MINI_STREAM_CUTOFF - 1)
		for (let i = 0; i < payload.length; i++) payload[i] = (i * 5 + 1) % 251

		const entries: MSGBurnerEntry[] = [
			{ name: 'Root Entry', category: MSG_CATEGORY_ROOT, children: [1], length: 0 },
			{
				name: '__attach_version1.0_#00000000',
				category: MSG_CATEGORY_DIRECTORY,
				children: [2],
				length: 0,
			},
			{
				name: '__substg1.0_37010102',
				category: MSG_CATEGORY_DOCUMENT,
				binaryProvider: () => payload,
				length: payload.length,
			},
		]

		const binary = burnCFB(entries)
		const parsed = new MSG(binary)
		const attachment = parsed.attachment(0)

		expect(attachment.bytes.length).toBe(payload.length)
		expect(Array.from(attachment.bytes)).toEqual(Array.from(payload))
	})

	it('burns and round-trips a stream one byte OVER the cutoff (standard sectors)', () => {
		const payload = new Uint8Array(MSG_BURNER_MINI_STREAM_CUTOFF + 1)
		for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 3) % 251

		const entries: MSGBurnerEntry[] = [
			{ name: 'Root Entry', category: MSG_CATEGORY_ROOT, children: [1], length: 0 },
			{
				name: '__attach_version1.0_#00000000',
				category: MSG_CATEGORY_DIRECTORY,
				children: [2],
				length: 0,
			},
			{
				name: '__substg1.0_37010102',
				category: MSG_CATEGORY_DOCUMENT,
				binaryProvider: () => payload,
				length: payload.length,
			},
		]

		const binary = burnCFB(entries)
		const parsed = new MSG(binary)
		const attachment = parsed.attachment(0)

		expect(attachment.bytes.length).toBe(payload.length)
		expect(Array.from(attachment.bytes)).toEqual(Array.from(payload))
	})
})

describe('burnCFB — multiple children and directory ordering', () => {
	it('burns and round-trips several attachments, exercising compareCFBName ordering', () => {
		// Names differing only by case ('a' vs 'B') and by length ('a'/'B' vs
		// 'AA'/'aa') deterministically exercise compareCFBName's length-first,
		// then case-insensitive comparator while building the red-black tree.
		const names = ['B', 'a', 'AA', 'aa']
		const payloads = names.map((_name, index) => {
			const payload = new Uint8Array(10)
			payload.fill(index + 1)
			return payload
		})

		const entries: MSGBurnerEntry[] = [
			{
				name: 'Root Entry',
				category: MSG_CATEGORY_ROOT,
				children: names.map((_, i) => 1 + i * 2),
				length: 0,
			},
		]
		names.forEach((_name, index) => {
			const dirIndex = entries.length
			const docIndex = dirIndex + 1
			const payload = requireValue(payloads[index])
			entries.push({
				name: `__attach_version1.0_#${String(index).padStart(8, '0')}`,
				category: MSG_CATEGORY_DIRECTORY,
				children: [docIndex],
				length: 0,
			})
			entries.push({
				name: '__substg1.0_37010102',
				category: MSG_CATEGORY_DOCUMENT,
				binaryProvider: () => payload,
				length: payload.length,
			})
		})

		const binary = burnCFB(entries)
		const parsed = new MSG(binary)
		const fields = parsed.fields

		expect(fields?.attachments?.length).toBe(names.length)

		const expectedFirstBytes = new Set(payloads.map((payload) => payload[0]))
		const actualFirstBytes = new Set(
			(fields?.attachments ?? []).map((_, index) => {
				const bytes = parsed.attachment(index).bytes
				return requireValue(bytes[0])
			}),
		)
		expect(actualFirstBytes).toEqual(expectedFirstBytes)
	})

	it('writes a valid red-black directory tree for an incomplete level', () => {
		const entries: MSGBurnerEntry[] = [
			{ name: 'Root Entry', category: MSG_CATEGORY_ROOT, children: [1, 2, 3, 4], length: 0 },
			{ name: 'B', category: MSG_CATEGORY_DOCUMENT, length: 0 },
			{ name: 'a', category: MSG_CATEGORY_DOCUMENT, length: 0 },
			{ name: 'AA', category: MSG_CATEGORY_DOCUMENT, length: 0 },
			{ name: 'aa', category: MSG_CATEGORY_DOCUMENT, length: 0 },
		]

		const binary = burnCFB(entries)
		const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength)
		const directory = MSG_BURNER_SECTOR_SIZE
		const root = directory
		const first = directory + MSG_BURNER_DIR_ENTRY_SIZE
		const second = directory + MSG_BURNER_DIR_ENTRY_SIZE * 2
		const third = directory + MSG_BURNER_DIR_ENTRY_SIZE * 3
		const fourth = directory + MSG_BURNER_DIR_ENTRY_SIZE * 4

		expect(view.getInt32(root + 0x4c, true)).toBe(1)
		expect(view.getUint8(first + 0x43)).toBe(1)
		expect(view.getInt32(first + 0x44, true)).toBe(2)
		expect(view.getInt32(first + 0x48, true)).toBe(3)
		expect(view.getUint8(second + 0x43)).toBe(1)
		expect(view.getUint8(third + 0x43)).toBe(1)
		expect(view.getInt32(third + 0x48, true)).toBe(4)
		expect(view.getUint8(fourth + 0x43)).toBe(0)
	})
})

describe('burnCFB — directory name cap', () => {
	it('burns fine with a name exactly at the 31 UTF-16 unit cap', () => {
		const name = 'a'.repeat(MSG_BURNER_NAME_MAX)
		expect(name.length).toBe(31)

		const entries: MSGBurnerEntry[] = [
			{ name: 'Root Entry', category: MSG_CATEGORY_ROOT, children: [1], length: 0 },
			{
				name,
				category: MSG_CATEGORY_DOCUMENT,
				binaryProvider: () => new Uint8Array([1]),
				length: 1,
			},
		]

		const result = burnCFB(entries)
		expect(isMSGFile(new DataView(result.buffer, result.byteOffset, result.byteLength))).toBe(true)
	})

	it('throws MSGError(BURN) for a name one unit OVER the cap (32 units)', () => {
		const name = 'a'.repeat(MSG_BURNER_NAME_MAX + 1)
		expect(name.length).toBe(32)

		const entries: MSGBurnerEntry[] = [
			{ name: 'Root Entry', category: MSG_CATEGORY_ROOT, children: [1], length: 0 },
			{
				name,
				category: MSG_CATEGORY_DOCUMENT,
				binaryProvider: () => new Uint8Array([1]),
				length: 1,
			},
		]

		const thrown = captureError(() => burnCFB(entries))

		expect(isMSGError(thrown)).toBe(true)
		expect(isMSGError(thrown) && thrown.code).toBe('BURN')
		expect(isMSGError(thrown) && thrown.message).toMatch(/name|character/i)
	})
})

describe('burnCFB — structurally invalid entries (never a raw TypeError)', () => {
	it('throws MSGError(BURN), not a raw TypeError, for an oversized name nested deep in the tree', () => {
		// The only validated invariant burnCFB enforces on a directory entry is
		// the MSG_BURNER_NAME_MAX name-length cap (see the "name cap" suite
		// above). This exercises that same guard at a NON-root tree position —
		// a document nested inside a directory nested inside the root —
		// confirming the validation applies uniformly across the tree
		// structure rather than only at the top level, and that the failure is
		// always a typed MSGError rather than an unguarded TypeError from
		// malformed traversal.
		const oversized = 'x'.repeat(MSG_BURNER_NAME_MAX + 1)

		const entries: MSGBurnerEntry[] = [
			{ name: 'Root Entry', category: MSG_CATEGORY_ROOT, children: [1], length: 0 },
			{
				name: '__attach_version1.0_#00000000',
				category: MSG_CATEGORY_DIRECTORY,
				children: [2],
				length: 0,
			},
			{
				name: oversized,
				category: MSG_CATEGORY_DOCUMENT,
				binaryProvider: () => new Uint8Array([1]),
				length: 1,
			},
		]

		const thrown = captureError(() => burnCFB(entries))

		expect(isMSGError(thrown)).toBe(true)
		expect(isMSGError(thrown) && thrown.code).toBe('BURN')
		expect(thrown instanceof TypeError).toBe(false)
	})

	it('rejects a cyclic directory graph with MSGError(BURN)', () => {
		const entries: MSGBurnerEntry[] = [
			{ name: 'Root Entry', category: MSG_CATEGORY_ROOT, children: [1], length: 0 },
			{ name: 'First', category: MSG_CATEGORY_DIRECTORY, children: [2], length: 0 },
			{ name: 'Second', category: MSG_CATEGORY_DIRECTORY, children: [1], length: 0 },
		]

		const thrown = captureError(() => burnCFB(entries))

		expect(isMSGError(thrown)).toBe(true)
		expect(isMSGError(thrown) && thrown.code).toBe('BURN')
	})
})

describe('burnCFB — DIFAT allocation boundary', () => {
	it('includes DIFAT sectors in the FAT fixed point', () => {
		const entries: MSGBurnerEntry[] = [
			{ name: 'Root Entry', category: MSG_CATEGORY_ROOT, children: [1], length: 0 },
			{ name: 'Large', category: MSG_CATEGORY_DOCUMENT, length: 8_322_560 },
		]

		const binary = burnCFB(entries)
		const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength)

		expect(view.getInt32(0x2c, true)).toBe(129)
		expect(view.getInt32(0x44, true)).toBeGreaterThanOrEqual(0)
		expect(() => new MSG(binary)).not.toThrow()
	})

	it('terminates an exactly full final DIFAT sector', () => {
		const entries: MSGBurnerEntry[] = [
			{ name: 'Root Entry', category: MSG_CATEGORY_ROOT, children: [1], length: 0 },
			{ name: 'Large', category: MSG_CATEGORY_DOCUMENT, length: 15_280_128 },
		]

		const binary = burnCFB(entries)
		const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength)
		const firstDifatSector = view.getInt32(0x44, true)
		const finalLink =
			MSG_BURNER_SECTOR_SIZE * (1 + firstDifatSector) +
			(MSG_BURNER_SECTOR_SIZE - Int32Array.BYTES_PER_ELEMENT)

		expect(view.getInt32(0x2c, true)).toBe(236)
		expect(view.getInt32(finalLink, true)).toBe(MSG_END_OF_CHAIN)
	})
})
