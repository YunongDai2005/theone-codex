import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { readArchiveFile, rewriteArchive, updateIntegrityResource } from './archive.mjs'

const sha = buffer => createHash('sha256').update(buffer).digest('hex')
function fixture(directory) {
  const content = Buffer.from('original\nuntouched'), replacement = Buffer.from('longer new renderer'),
    json = Buffer.from(JSON.stringify({ files: {
      'renderer.js': { size: 8, offset: '0', integrity: { algorithm: 'SHA256', hash: sha(content.subarray(0, 8)), blockSize: 4, blocks: [sha(content.subarray(0,4)), sha(content.subarray(4,8))] } },
      'other.bin': { size: content.length - 8, offset: '8' },
      'native.node': { size: 90, unpacked: true },
      'alias': { link: 'other.bin' },
    } })), aligned = Math.ceil(json.length / 4) * 4,
    header = Buffer.alloc(aligned + 16)
  header.writeUInt32LE(4, 0); header.writeUInt32LE(aligned + 8, 4)
  header.writeUInt32LE(aligned + 4, 8); header.writeUInt32LE(json.length, 12); json.copy(header, 16)
  const path = join(directory, 'original.asar'), bytes = Buffer.concat([header, content])
  writeFileSync(path, bytes)
  return { path, bytes, replacement, other: content.subarray(8), oldHeaderHash: sha(json) }
}

test('rebuild keeps original payload and sidecar metadata, and updates entry and root integrity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'theone-asar-'))
  try {
    const f = fixture(directory), output = join(directory, 'adapted.asar')
    const result = rewriteArchive(f.path, output, new Map([['renderer.js', f.replacement]]))
    assert.deepEqual(readFileSync(f.path), f.bytes, 'Original archive must remain byte-for-byte intact')
    assert.deepEqual(readArchiveFile(output, 'renderer.js'), f.replacement)
    assert.deepEqual(readArchiveFile(output, 'other.bin'), f.other)
    const data = readFileSync(output), json = data.subarray(16, 16 + data.readUInt32LE(12)), header = JSON.parse(json)
    assert.equal(result.originalHeaderHash, f.oldHeaderHash)
    assert.equal(result.headerHash, sha(json))
    assert.equal(header.files['renderer.js'].integrity.hash, sha(f.replacement))
    assert.equal(header.files['renderer.js'].integrity.blocks.length, 5)
    assert.equal(header.files['native.node'].unpacked, true)
    assert.equal(header.files.alias.link, 'other.bin')
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('refuses in-place mutation, overwrite, and missing replacement targets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'theone-asar-'))
  try {
    const f = fixture(directory), replacements = new Map([['renderer.js', f.replacement]])
    assert.throws(() => rewriteArchive(f.path, f.path, replacements), /in.place|same/i)
    const output = join(directory, 'existing.asar'); writeFileSync(output, 'preserve')
    assert.throws(() => rewriteArchive(f.path, output, replacements), /exists|EEXIST/i)
    assert.equal(readFileSync(output, 'utf8'), 'preserve')
    assert.throws(() => rewriteArchive(f.path, join(directory, 'bad.asar'), new Map([['missing.js', f.replacement]])), /missing|not found/i)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('rebinds the local executable integrity resource without disabling validation or changing other bytes', () => {
  const beforeHash = 'a'.repeat(64), afterHash = 'b'.repeat(64)
  const resource = JSON.stringify([{ file: 'resources\\app.asar', alg: 'SHA256', value: beforeHash }])
  const input = Buffer.from('MZ runtime prefix\0' + resource + '\0runtime suffix')
  const result = updateIntegrityResource(input, beforeHash, afterHash)
  assert.equal(result.toString(), input.toString().replace(beforeHash, afterHash))
  assert.ok(input.includes(beforeHash), 'Original executable buffer must remain intact')
  assert.throws(() => updateIntegrityResource(input, 'c'.repeat(64), afterHash), /mismatch/i)
  assert.throws(() => updateIntegrityResource(Buffer.concat([input, input]), beforeHash, afterHash), /ambiguous|multiple/i)
})
