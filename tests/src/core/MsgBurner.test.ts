import { describe, expect, it } from 'vitest'
import {
	MsgBurner,
	createMsgReader,
	isMsgFile,
	isMsgError,
	MSG_TYPE_ROOT,
	MSG_TYPE_DIRECTORY,
	MSG_TYPE_DOCUMENT,
	MSG_BURNER_MINI_STREAM_CUTOFF,
	MSG_BURNER_NAME_MAX,
} from '@src/core'
import type { MsgBurnerEntry } from '@src/core'
import { captureError, expectDefined } from '../../setup.js'

// The MSG burner reconstitutes a CFB (Compound Binary File) from a flat list
// of MsgBurnerEntry descriptors — root storage at index 0, children reachable
// through `children` indices. The load-bearing behavior: entries below the
// mini-stream cutoff land in the mini-FAT/mini-stream, entries at/above it
// land in the regular FAT sectors, the directory red-black tree is built via
// compareCfbName (length-first, then case-insensitive) ordering, directory
// entry names are capped at MSG_BURNER_NAME_MAX UTF-16 units, and every
// failure surfaces as a typed MsgError (code BURN) — never a raw TypeError.
// Round-trips are verified by re-parsing burned output with the real
// MsgReader (no mocks, per AGENTS §16).

describe('MsgBurner — minimal burn', () => {
	it('burns a root-only entry list into a valid CFB file', () => {
		const burner = new MsgBurner()
		const entries: MsgBurnerEntry[] = [
			{ name: 'Root Entry', type: MSG_TYPE_ROOT, children: [], length: 0 },
		]

		const result = burner.burn(entries)
		const view = new DataView(result.buffer, result.byteOffset, result.byteLength)

		expect(isMsgFile(view)).toBe(true)
	})
})

describe('MsgBurner — mini-stream cutoff boundary (round-trip)', () => {
	it('burns and round-trips a stream one byte UNDER the cutoff (mini-stream)', () => {
		const payload = new Uint8Array(MSG_BURNER_MINI_STREAM_CUTOFF - 1)
		for (let i = 0; i < payload.length; i++) payload[i] = (i * 5 + 1) % 251

		const entries: MsgBurnerEntry[] = [
			{ name: 'Root Entry', type: MSG_TYPE_ROOT, children: [1], length: 0 },
			{
				name: '__attach_version1.0_#00000000',
				type: MSG_TYPE_DIRECTORY,
				children: [2],
				length: 0,
			},
			{
				name: '__substg1.0_37010102',
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => payload,
				length: payload.length,
			},
		]

		const binary = new MsgBurner().burn(entries)
		const reader = createMsgReader(binary)
		const attachment = reader.attachment(0)

		expect(attachment.content.length).toBe(payload.length)
		expect(Array.from(attachment.content)).toEqual(Array.from(payload))
	})

	it('burns and round-trips a stream one byte OVER the cutoff (standard sectors)', () => {
		const payload = new Uint8Array(MSG_BURNER_MINI_STREAM_CUTOFF + 1)
		for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 3) % 251

		const entries: MsgBurnerEntry[] = [
			{ name: 'Root Entry', type: MSG_TYPE_ROOT, children: [1], length: 0 },
			{
				name: '__attach_version1.0_#00000000',
				type: MSG_TYPE_DIRECTORY,
				children: [2],
				length: 0,
			},
			{
				name: '__substg1.0_37010102',
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => payload,
				length: payload.length,
			},
		]

		const binary = new MsgBurner().burn(entries)
		const reader = createMsgReader(binary)
		const attachment = reader.attachment(0)

		expect(attachment.content.length).toBe(payload.length)
		expect(Array.from(attachment.content)).toEqual(Array.from(payload))
	})
})

describe('MsgBurner — multiple children and directory ordering', () => {
	it('burns and round-trips several attachments, exercising compareCfbName ordering', () => {
		// Names differing only by case ('a' vs 'B') and by length ('a'/'B' vs
		// 'AA'/'aa') deterministically exercise compareCfbName's length-first,
		// then case-insensitive comparator while building the red-black tree.
		const names = ['B', 'a', 'AA', 'aa']
		const payloads = names.map((_name, index) => {
			const payload = new Uint8Array(10)
			payload.fill(index + 1)
			return payload
		})

		const entries: MsgBurnerEntry[] = [
			{
				name: 'Root Entry',
				type: MSG_TYPE_ROOT,
				children: names.map((_, i) => 1 + i * 2),
				length: 0,
			},
		]
		names.forEach((name, index) => {
			const dirIndex = entries.length
			const docIndex = dirIndex + 1
			entries.push({
				name: `__attach_version1.0_#${String(index).padStart(8, '0')}`,
				type: MSG_TYPE_DIRECTORY,
				children: [docIndex],
				length: 0,
			})
			entries.push({
				name: '__substg1.0_37010102',
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => payloads[index],
				length: payloads[index].length,
			})
		})

		const binary = new MsgBurner().burn(entries)
		const reader = createMsgReader(binary)
		const parsed = reader.parse()

		expect(parsed.attachments?.length).toBe(names.length)

		const expectedFirstBytes = new Set(payloads.map((payload) => payload[0]))
		const actualFirstBytes = new Set(
			(parsed.attachments ?? []).map((_, index) => {
				const content = reader.attachment(index).content
				return expectDefined(content[0])
			}),
		)
		expect(actualFirstBytes).toEqual(expectedFirstBytes)
	})
})

describe('MsgBurner — directory name cap', () => {
	it('burns fine with a name exactly at the 31 UTF-16 unit cap', () => {
		const name = 'a'.repeat(MSG_BURNER_NAME_MAX)
		expect(name.length).toBe(31)

		const entries: MsgBurnerEntry[] = [
			{ name: 'Root Entry', type: MSG_TYPE_ROOT, children: [1], length: 0 },
			{ name, type: MSG_TYPE_DOCUMENT, binaryProvider: () => new Uint8Array([1]), length: 1 },
		]

		const result = new MsgBurner().burn(entries)
		expect(isMsgFile(new DataView(result.buffer, result.byteOffset, result.byteLength))).toBe(true)
	})

	it('throws MsgError(BURN) for a name one unit OVER the cap (32 units)', () => {
		const name = 'a'.repeat(MSG_BURNER_NAME_MAX + 1)
		expect(name.length).toBe(32)

		const entries: MsgBurnerEntry[] = [
			{ name: 'Root Entry', type: MSG_TYPE_ROOT, children: [1], length: 0 },
			{ name, type: MSG_TYPE_DOCUMENT, binaryProvider: () => new Uint8Array([1]), length: 1 },
		]

		const thrown = captureError(() => new MsgBurner().burn(entries))

		expect(isMsgError(thrown)).toBe(true)
		expect(isMsgError(thrown) && thrown.code).toBe('BURN')
		expect(isMsgError(thrown) && thrown.message).toMatch(/name|character/i)
	})
})

describe('MsgBurner — structurally invalid entries (never a raw TypeError)', () => {
	it('throws MsgError(BURN), not a raw TypeError, for an oversized name nested deep in the tree', () => {
		// The only validated invariant MsgBurner enforces on a directory
		// entry is the MSG_BURNER_NAME_MAX name-length cap (see the "name
		// cap" suite above). This exercises that same guard at a NON-root
		// tree position — a document nested inside a directory nested inside
		// the root — confirming the validation applies uniformly across the
		// tree structure rather than only at the top level, and that the
		// failure is always a typed MsgError rather than an unguarded
		// TypeError from malformed traversal.
		const oversized = 'x'.repeat(MSG_BURNER_NAME_MAX + 1)

		const entries: MsgBurnerEntry[] = [
			{ name: 'Root Entry', type: MSG_TYPE_ROOT, children: [1], length: 0 },
			{
				name: '__attach_version1.0_#00000000',
				type: MSG_TYPE_DIRECTORY,
				children: [2],
				length: 0,
			},
			{
				name: oversized,
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => new Uint8Array([1]),
				length: 1,
			},
		]

		const thrown = captureError(() => new MsgBurner().burn(entries))

		expect(isMsgError(thrown)).toBe(true)
		expect(isMsgError(thrown) && thrown.code).toBe('BURN')
		expect(thrown instanceof TypeError).toBe(false)
	})
})
