import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
	createMSGReader,
	createMSGBurner,
	createEmailParser,
	MSGReader,
	MSGBurner,
	EmailParser,
} from '@src/core'
import { describe, expect, it } from 'vitest'

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url))

function readFixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(`${fixturesDir}${name}`))
}

// createMSGReader — factory returns a working MSGReaderInterface. Full
// parse behavior lives in MSGReader.test.ts; here we assert the factory
// hands back a usable, correctly-typed instance across both input forms.

describe('createMSGReader', () => {
	it('returns an instance of MSGReader', () => {
		const bytes = readFixture('test.msg')
		const reader = createMSGReader(bytes)

		expect(reader).toBeInstanceOf(MSGReader)
	})

	it('parses a Uint8Array input', () => {
		const bytes = readFixture('test.msg')
		const reader = createMSGReader(bytes)

		const data = reader.parse()
		expect(data.kind).toBe('msg')
	})

	it('parses an ArrayBuffer input', () => {
		const bytes = readFixture('test.msg')
		const buffer = new ArrayBuffer(bytes.byteLength)
		new Uint8Array(buffer).set(bytes)
		const reader = createMSGReader(buffer)

		const data = reader.parse()
		expect(data.kind).toBe('msg')
	})

	it('threads an { encoding } option through to non-Unicode string decoding', () => {
		const bytes = readFixture('test.msg')
		const defaultReader = createMSGReader(bytes)
		const latin1Reader = createMSGReader(bytes, { encoding: 'latin1' })

		const defaultData = defaultReader.parse()
		const latin1Data = latin1Reader.parse()

		expect(defaultData.kind).toBe('msg')
		expect(latin1Data.kind).toBe('msg')
	})
})

// createMSGBurner — factory returns a working MSGBurnerInterface capable of
// burning a minimal entry list into a valid CFB binary.

describe('createMSGBurner', () => {
	it('returns an instance of MSGBurner', () => {
		const burner = createMSGBurner()

		expect(burner).toBeInstanceOf(MSGBurner)
	})

	it('burns a minimal entry list (root only) into a CFB binary', () => {
		const burner = createMSGBurner()

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
		const burner = createMSGBurner()
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
