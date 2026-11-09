import { openSync, closeSync, readSync, writeSync, fstatSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

const sha = data => createHash('sha256').update(data).digest('hex')
function readExact(fd, length, position) {
  const buffer = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const count = readSync(fd, buffer, offset, length - offset, position + offset)
    if (!count) throw new Error('Truncated archive')
    offset += count
  }
  return buffer
}
function writeAll(fd, buffer) {
  for (let offset = 0; offset < buffer.length;) offset += writeSync(fd, buffer, offset, buffer.length - offset)
}
function inspect(fd) {
  const prefix = readExact(fd, 16, 0), size = fstatSync(fd).size
  const length = prefix.readUInt32LE(12), base = 8 + prefix.readUInt32LE(4)
  if (prefix.readUInt32LE(0) !== 4 || length > 64 * 1024 * 1024 || length + 16 > base || base > size) throw new Error('Invalid archive header')
  const json = readExact(fd, length, 16)
  return { header: JSON.parse(json), headerHash: sha(json), base, size }
}
function entryAt(header, path) {
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\'))) throw new Error('Invalid archive path')
  let entry = header
  for (const part of parts) entry = entry?.files?.[part]
  if (!entry || entry.files || entry.link || entry.unpacked) throw new Error(`Packed file missing: ${path}`)
  return entry
}
export function readArchiveFile(path, entryPath) {
  const fd = openSync(path, 'r')
  try {
    const archive = inspect(fd), entry = entryAt(archive.header, entryPath), offset = Number(entry.offset)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(entry.size) || entry.size < 0 || archive.base + offset + entry.size > archive.size) throw new Error('Invalid archive entry bounds')
    return readExact(fd, entry.size, archive.base + offset)
  } finally { closeSync(fd) }
}
export function rewriteArchive(source, target, replacements) {
  if (resolve(source).toLowerCase() === resolve(target).toLowerCase()) throw new Error('In-place archive mutation is forbidden')
  const input = openSync(source, 'r')
  let output, complete = false
  try {
    const archive = inspect(input), appended = [], changes = []
    let offset = archive.size - archive.base
    for (const [path, bytes] of replacements) {
      const entry = entryAt(archive.header, path), data = Buffer.from(bytes)
      const blockSize = entry.integrity?.blockSize ?? 4194304
      if (!Number.isSafeInteger(blockSize) || blockSize < 1) throw new Error('Invalid integrity block size')
      const blocks = []
      for (let start = 0; start < data.length; start += blockSize) blocks.push(sha(data.subarray(start, start + blockSize)))
      entry.offset = String(offset); entry.size = data.length
      entry.integrity = { algorithm: 'SHA256', hash: sha(data), blockSize, blocks }
      appended.push(data); changes.push({ path, size: data.length, sha256: sha(data) }); offset += data.length
    }
    const json = Buffer.from(JSON.stringify(archive.header)), aligned = Math.ceil(json.length / 4) * 4
    const header = Buffer.alloc(aligned + 16)
    header.writeUInt32LE(4, 0); header.writeUInt32LE(aligned + 8, 4)
    header.writeUInt32LE(aligned + 4, 8); header.writeUInt32LE(json.length, 12); json.copy(header, 16)
    output = openSync(target, 'wx')
    writeAll(output, header)
    for (let position = archive.base; position < archive.size;) {
      const data = readExact(input, Math.min(8 * 1024 * 1024, archive.size - position), position)
      writeAll(output, data); position += data.length
    }
    for (const data of appended) writeAll(output, data)
    complete = true
    return { originalHeaderHash: archive.headerHash, headerHash: sha(json), changes }
  } finally {
    closeSync(input)
    if (output !== undefined) { closeSync(output); if (!complete) unlinkSync(target) }
  }
}
export function updateIntegrityResource(buffer, expectedHash, newHash) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || !/^[a-f0-9]{64}$/.test(newHash)) throw new Error('Invalid SHA-256')
  const text = buffer.toString('latin1')
  const matches = [...text.matchAll(/\[\{"file":"resources\\\\app\.asar","alg":"SHA256","value":"([a-f0-9]{64})"\}\]/g)]
  if (matches.length !== 1) throw new Error('Missing or ambiguous executable ASAR integrity resource')
  const match = matches[0]
  if (match[1] !== expectedHash) throw new Error('Executable and archive integrity mismatch')
  const output = Buffer.from(buffer), offset = match.index + match[0].indexOf(expectedHash)
  output.write(newHash, offset, 64, 'ascii')
  return output
}
