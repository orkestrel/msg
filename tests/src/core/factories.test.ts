import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
	createMsgReader,
	createMsgBurner,
	createEmailParser,
	MsgReader,
	MsgBurner,
	EmailParser,
} from '@src/core'
import { describe, expect, it } from 'vitest'

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url))

function readFixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(`${fixturesDir}${name}`))
}

// createMsgReader — factory returns a working MsgReaderInterface. Full
// parse behavior lives in MsgReader.test.ts; here we assert the factory
// hands back a usable, correctly-typed instance across both input forms.

describe('createMsgReader', () => {
	it('returns an instance of MsgReader', () => {
		const bytes = readFixture('test.msg')
		const reader = createMsgReader(bytes)

		expect(reader).toBeInstanceOf(MsgReader)
	})

	it('parses a Uint8Array input', () => {
		const bytes = readFixture('test.msg')
		const reader = createMsgReader(bytes)

		const data = reader.parse()
		expect(data.kind).toBe('msg')
	})

	it('parses an ArrayBuffer input', () => {
		const bytes = readFixture('test.msg')
		const buffer = new ArrayBuffer(bytes.byteLength)
		new Uint8Array(buffer).set(bytes)
		const reader = createMsgReader(buffer)

		const data = reader.parse()
		expect(data.kind).toBe('msg')
	})

	it('threads an { encoding } option through to non-Unicode string decoding', () => {
		const bytes = readFixture('test.msg')
		const defaultReader = createMsgReader(bytes)
		const latin1Reader = createMsgReader(bytes, { encoding: 'latin1' })

		const defaultData = defaultReader.parse()
		const latin1Data = latin1Reader.parse()

		expect(defaultData.kind).toBe('msg')
		expect(latin1Data.kind).toBe('msg')
	})
})

// createMsgBurner — factory returns a working MsgBurnerInterface capable of
// burning a minimal entry list into a valid CFB binary.

describe('createMsgBurner', () => {
	it('returns an instance of MsgBurner', () => {
		const burner = createMsgBurner()

		expect(burner).toBeInstanceOf(MsgBurner)
	})

	it('burns a minimal entry list (root only) into a CFB binary', () => {
		const burner = createMsgBurner()

		const binary = burner.burn([
			{
				name: 'Root Entry',
				type: 5,
				children: [],
				length: 0,
			},
		])

		expect(binary).toBeInstanceOf(Uint8Array)
		expect(binary.length).toBeGreaterThan(0)
	})

	it('burns a minimal entry list with one document stream child', () => {
		const burner = createMsgBurner()
		const content = new Uint8Array([1, 2, 3, 4])

		const binary = burner.burn([
			{
				name: 'Root Entry',
				type: 5,
				children: [1],
				length: 0,
			},
			{
				name: 'stream',
				type: 2,
				length: content.length,
				binaryProvider: () => content,
			},
		])

		expect(binary).toBeInstanceOf(Uint8Array)
		expect(binary.length).toBeGreaterThan(0)
	})
})

// createEmailParser — factory returns a working EmailParserInterface with
// default options, and threads an explicit encoding through to `.options`.

describe('createEmailParser', () => {
	it('returns an instance of EmailParser', () => {
		const parser = createEmailParser()

		expect(parser).toBeInstanceOf(EmailParser)
	})

	it('exposes default options when none are given', () => {
		const parser = createEmailParser()

		expect(parser.options).toEqual({})
	})

	it('exposes an explicit { encoding } option via .options', () => {
		const parser = createEmailParser({ encoding: 'latin1' })

		expect(parser.options).toEqual({ encoding: 'latin1' })
	})

	it('parses with a working parser instance', () => {
		const parser = createEmailParser()
		const bytes = readFixture('test.msg')

		const result = parser.parse({ bytes, name: 'message.msg' })
		expect(result.success).toBe(true)
	})
})
