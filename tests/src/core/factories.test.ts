import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, it, expect } from 'vitest'
import { createMSG, isSuccess, isFailure, isMSGError } from '@src/core'

const fixturesDir = fileURLToPath(new URL('./fixtures/', import.meta.url))

function readFixture(name: string): Uint8Array {
	return new Uint8Array(readFileSync(`${fixturesDir}${name}`))
}

// createMSG — the total Result-returning boundary counterpart to `new MSG()`
// (which parses eagerly and throws). createMSG never throws: success wraps a
// working MSGInterface, failure wraps the typed MSGError.

describe('createMSG — success', () => {
	it('parses a real .msg fixture into a working MSGInterface', () => {
		const bytes = readFixture('test.msg')
		const result = createMSG(bytes)

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) throw new Error('unreachable')
		expect(result.value.chain.format).toBe('msg')
		expect(result.value.chain.messages).toHaveLength(1)
	})

	it('parses an .eml input into a working MSGInterface', () => {
		const text = 'Subject: Hello\r\n\r\nBody text'
		const bytes = new TextEncoder().encode(text)
		const result = createMSG({ bytes, name: 'message.eml' })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) throw new Error('unreachable')
		expect(result.value.chain.format).toBe('eml')
		expect(result.value.chain.messages[0]?.subject).toBe('Hello')
		expect(result.value.fields).toBeUndefined()
	})

	it('threads an { encoding } option through to .options', () => {
		const bytes = readFixture('test.msg')
		const result = createMSG(bytes, { encoding: 'latin1' })

		expect(isSuccess(result)).toBe(true)
		if (!isSuccess(result)) throw new Error('unreachable')
		expect(result.value.options).toEqual({ encoding: 'latin1' })
	})
})

describe('createMSG — failure', () => {
	it('never throws on malformed input — returns a Failure carrying an MSGError', () => {
		const bytes = new TextEncoder().encode('not a compound file at all')
		const result = createMSG(bytes)

		expect(isFailure(result)).toBe(true)
		if (!isFailure(result)) throw new Error('unreachable')
		expect(isMSGError(result.error)).toBe(true)
		if (!isMSGError(result.error)) throw new Error('unreachable')
		expect(result.error.code).toBe('UNSUPPORTED')
	})

	it('never throws on an empty input', () => {
		const result = createMSG(new Uint8Array(0))

		expect(isFailure(result)).toBe(true)
		if (!isFailure(result)) throw new Error('unreachable')
		expect(isMSGError(result.error)).toBe(true)
	})
})
