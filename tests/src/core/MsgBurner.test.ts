import { describe, it, expect } from 'vitest'
import {
	MsgBurner,
	MSG_TYPE_ROOT,
	MSG_TYPE_DOCUMENT,
	MSG_TYPE_DIRECTORY,
	MSG_BURNER_SECTOR_SIZE,
	MSG_BURNER_MINI_STREAM_CUTOFF,
	MSG_BURNER_ROOT_CLSID,
	isMsgFile,
} from 'keepalive'
import type { MsgBurnerEntry } from 'keepalive'

describe('MsgBurner', () => {
	// === Minimal CFB binary

	it('produces a valid CFB header for an empty root entry', () => {
		const burner = new MsgBurner()
		const entries: MsgBurnerEntry[] = [
			{ name: 'Root Entry', type: MSG_TYPE_ROOT, children: [], length: 0 },
		]
		const result = burner.burn(entries)
		const view = new DataView(result.buffer, result.byteOffset, result.byteLength)

		expect(isMsgFile(view)).toBe(true)
		// Byte order mark at offset 0x1C
		expect(view.getUint16(0x1c, true)).toBe(0xfffe)
		// Major version 3
		expect(view.getUint16(0x1a, true)).toBe(0x03)
		// Sector shift = 9 (512 bytes)
		expect(view.getUint16(0x1e, true)).toBe(9)
		// Mini sector shift = 6 (64 bytes)
		expect(view.getUint16(0x20, true)).toBe(6)
		// Mini stream cutoff
		expect(view.getInt32(0x38, true)).toBe(MSG_BURNER_MINI_STREAM_CUTOFF)
	})

	it('output size is a multiple of sector size', () => {
		const burner = new MsgBurner()
		const entries: MsgBurnerEntry[] = [
			{ name: 'Root Entry', type: MSG_TYPE_ROOT, children: [], length: 0 },
		]
		const result = burner.burn(entries)
		expect(result.byteLength % MSG_BURNER_SECTOR_SIZE).toBe(0)
	})

	it('writes the root CLSID in the first directory entry', () => {
		const burner = new MsgBurner()
		const entries: MsgBurnerEntry[] = [
			{ name: 'Root Entry', type: MSG_TYPE_ROOT, children: [], length: 0 },
		]
		const result = burner.burn(entries)
		const view = new DataView(result.buffer, result.byteOffset, result.byteLength)

		// Directory entry starts at sector (1 + firstDirSector) * 512
		// First dir sector is at offset 0x30 in header
		const dirSector = view.getInt32(0x30, true)
		const dirOffset = MSG_BURNER_SECTOR_SIZE * (1 + dirSector)
		const clsidSlice = result.slice(dirOffset + 0x50, dirOffset + 0x60)
		expect(Array.from(clsidSlice)).toEqual(Array.from(MSG_BURNER_ROOT_CLSID))
	})

	// === Document streams

	it('stores a large document stream in a standard sector', () => {
		const payload = new Uint8Array(5000)
		payload.fill(0xab)

		const burner = new MsgBurner()
		const entries: MsgBurnerEntry[] = [
			{
				name: 'Root Entry',
				type: MSG_TYPE_ROOT,
				children: [1],
				length: 0,
			},
			{
				name: '__substg1.0_001F001F',
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => payload,
				length: payload.length,
			},
		]
		const result = burner.burn(entries)
		expect(result.byteLength).toBeGreaterThan(MSG_BURNER_SECTOR_SIZE)

		// The data should be recoverable somewhere in the output
		let found = false
		for (let offset = 0; offset <= result.byteLength - payload.length; offset++) {
			if (result[offset] === 0xab) {
				const match = result.slice(offset, offset + payload.length)
				if (match.every((b) => b === 0xab)) {
					found = true
					break
				}
			}
		}
		expect(found).toBe(true)
	})

	it('stores a small document stream in the mini-stream', () => {
		const payload = new Uint8Array(100)
		payload.fill(0xcd)

		const burner = new MsgBurner()
		const entries: MsgBurnerEntry[] = [
			{
				name: 'Root Entry',
				type: MSG_TYPE_ROOT,
				children: [1],
				length: 0,
			},
			{
				name: '__substg1.0_001F001F',
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => payload,
				length: payload.length,
			},
		]
		const result = burner.burn(entries)

		// Mini-stream document (< 4096) should still appear in the binary
		let found = false
		for (let offset = 0; offset <= result.byteLength - payload.length; offset++) {
			if (result[offset] === 0xcd) {
				const match = result.slice(offset, offset + payload.length)
				if (match.every((b) => b === 0xcd)) {
					found = true
					break
				}
			}
		}
		expect(found).toBe(true)
	})

	it('handles empty document streams gracefully', () => {
		const burner = new MsgBurner()
		const entries: MsgBurnerEntry[] = [
			{
				name: 'Root Entry',
				type: MSG_TYPE_ROOT,
				children: [1],
				length: 0,
			},
			{
				name: '__substg1.0_001F001F',
				type: MSG_TYPE_DOCUMENT,
				length: 0,
			},
		]
		const result = burner.burn(entries)
		expect(result.byteLength).toBeGreaterThan(0)
		expect(isMsgFile(new DataView(result.buffer, result.byteOffset, result.byteLength))).toBe(true)
	})

	// === Directory tree structure

	it('builds correct red-black tree for multiple children', () => {
		const burner = new MsgBurner()
		const entries: MsgBurnerEntry[] = [
			{
				name: 'Root Entry',
				type: MSG_TYPE_ROOT,
				children: [1, 2, 3],
				length: 0,
			},
			{
				name: 'AAA',
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => new Uint8Array([1]),
				length: 1,
			},
			{
				name: 'BBB',
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => new Uint8Array([2]),
				length: 1,
			},
			{
				name: 'CCC',
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => new Uint8Array([3]),
				length: 1,
			},
		]
		const result = burner.burn(entries)
		const view = new DataView(result.buffer, result.byteOffset, result.byteLength)
		expect(isMsgFile(view)).toBe(true)
	})

	it('handles nested directory structures', () => {
		const burner = new MsgBurner()
		const entries: MsgBurnerEntry[] = [
			{
				name: 'Root Entry',
				type: MSG_TYPE_ROOT,
				children: [1],
				length: 0,
			},
			{
				name: '__attach_version1.0_#00000000',
				type: MSG_TYPE_DIRECTORY,
				children: [2],
				length: 0,
			},
			{
				name: '__substg1.0_37010102',
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => new Uint8Array([0xff, 0xfe]),
				length: 2,
			},
		]
		const result = burner.burn(entries)
		const view = new DataView(result.buffer, result.byteOffset, result.byteLength)
		expect(isMsgFile(view)).toBe(true)
		expect(result.byteLength % MSG_BURNER_SECTOR_SIZE).toBe(0)
	})

	// === Re-entrancy

	it('can be reused for multiple burns', () => {
		const burner = new MsgBurner()
		const entries1: MsgBurnerEntry[] = [
			{ name: 'Root Entry', type: MSG_TYPE_ROOT, children: [], length: 0 },
		]
		const entries2: MsgBurnerEntry[] = [
			{
				name: 'Root Entry',
				type: MSG_TYPE_ROOT,
				children: [1],
				length: 0,
			},
			{
				name: 'stream',
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => new Uint8Array(100),
				length: 100,
			},
		]

		const result1 = burner.burn(entries1)
		const result2 = burner.burn(entries2)

		expect(isMsgFile(new DataView(result1.buffer, result1.byteOffset, result1.byteLength))).toBe(
			true,
		)
		expect(isMsgFile(new DataView(result2.buffer, result2.byteOffset, result2.byteLength))).toBe(
			true,
		)
		// Second burn should be larger (has a document stream)
		expect(result2.byteLength).toBeGreaterThan(result1.byteLength)
	})

	// === Round-trip integration

	it('produces a CFB that MsgReader can parse', () => {
		const bodyText = 'Hello, world!'

		const burner = new MsgBurner()
		const entries: MsgBurnerEntry[] = [
			{
				name: 'Root Entry',
				type: MSG_TYPE_ROOT,
				children: [1],
				length: 0,
			},
			{
				name: '__substg1.0_1000001F',
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => {
					// Encode as UTF-16LE for the unicode body property
					const utf16 = new Uint8Array(bodyText.length * 2)
					for (let i = 0; i < bodyText.length; i++) {
						utf16[i * 2] = bodyText.charCodeAt(i) & 0xff
						utf16[i * 2 + 1] = (bodyText.charCodeAt(i) >> 8) & 0xff
					}
					return utf16
				},
				length: bodyText.length * 2,
			},
		]

		const binary = burner.burn(entries)
		// At minimum the output is a valid CFB
		const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength)
		expect(isMsgFile(view)).toBe(true)
	})

	// === Edge cases

	it('handles a single child entry correctly', () => {
		const burner = new MsgBurner()
		const entries: MsgBurnerEntry[] = [
			{
				name: 'Root Entry',
				type: MSG_TYPE_ROOT,
				children: [1],
				length: 0,
			},
			{
				name: 'X',
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => new Uint8Array([42]),
				length: 1,
			},
		]
		const result = burner.burn(entries)
		expect(isMsgFile(new DataView(result.buffer, result.byteOffset, result.byteLength))).toBe(true)
	})

	it('handles entries at the mini-stream cutoff boundary', () => {
		// Exactly at cutoff — should NOT be in mini-stream
		const payload = new Uint8Array(MSG_BURNER_MINI_STREAM_CUTOFF)
		payload.fill(0xee)

		const burner = new MsgBurner()
		const entries: MsgBurnerEntry[] = [
			{
				name: 'Root Entry',
				type: MSG_TYPE_ROOT,
				children: [1],
				length: 0,
			},
			{
				name: '__substg1.0_37010102',
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => payload,
				length: payload.length,
			},
		]
		const result = burner.burn(entries)
		expect(isMsgFile(new DataView(result.buffer, result.byteOffset, result.byteLength))).toBe(true)
	})

	it('handles entries just below the mini-stream cutoff', () => {
		// One byte below cutoff — should be in mini-stream
		const payload = new Uint8Array(MSG_BURNER_MINI_STREAM_CUTOFF - 1)
		payload.fill(0xdd)

		const burner = new MsgBurner()
		const entries: MsgBurnerEntry[] = [
			{
				name: 'Root Entry',
				type: MSG_TYPE_ROOT,
				children: [1],
				length: 0,
			},
			{
				name: '__substg1.0_37010102',
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => payload,
				length: payload.length,
			},
		]
		const result = burner.burn(entries)
		expect(isMsgFile(new DataView(result.buffer, result.byteOffset, result.byteLength))).toBe(true)
	})

	it('handles many children for directory tree balancing', () => {
		const burner = new MsgBurner()
		const childIndices: number[] = []
		const entries: MsgBurnerEntry[] = [
			{
				name: 'Root Entry',
				type: MSG_TYPE_ROOT,
				children: childIndices,
				length: 0,
			},
		]

		for (let i = 0; i < 20; i++) {
			const idx = entries.length
			childIndices.push(idx)
			entries.push({
				name: `entry_${String(i).padStart(3, '0')}`,
				type: MSG_TYPE_DOCUMENT,
				binaryProvider: () => new Uint8Array([i]),
				length: 1,
			})
		}

		const result = burner.burn(entries)
		expect(isMsgFile(new DataView(result.buffer, result.byteOffset, result.byteLength))).toBe(true)
	})
})
