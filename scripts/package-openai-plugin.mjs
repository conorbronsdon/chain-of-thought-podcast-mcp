/** Dependency-free, deterministic ZIP of the validated allowlist. */
import { lstatSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { ROOT, validate } from './validate-openai-plugin.mjs';

const crcTable = Array.from({length:256}, (_, n) => {
  for (let i=0; i<8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const {name, data} of entries) {
    const filename = Buffer.from(name, 'utf8');
    const compressed = deflateRawSync(data, {level:9});
    const crc = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0);
    header.writeUInt16LE(20,4); // ZIP 2.0
    header.writeUInt16LE(0x800,6); // UTF-8
    header.writeUInt16LE(8,8); // deflate
    header.writeUInt16LE(0x5c21,12); // 2026-01-01, midnight
    header.writeUInt32LE(crc,14);
    header.writeUInt32LE(compressed.length,18);
    header.writeUInt32LE(data.length,22);
    header.writeUInt16LE(filename.length,26);
    local.push(header,filename,compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50,0);
    directory.writeUInt16LE(0x314,4); // Unix, ZIP 2.0
    header.copy(directory,6,4,30);
    directory.writeUInt32LE((0o100644 << 16) >>> 0,38);
    directory.writeUInt32LE(offset,42);
    central.push(directory,filename);
    offset += header.length + filename.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);
  end.writeUInt16LE(entries.length,8);
  end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(directory.length,12);
  end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}
try {
  const entries = validate(); // Snapshot validated bytes, then package those same bytes.
  const dist = join(ROOT,'dist');
  try {
    const info = lstatSync(dist);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('dist must be a real directory');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  mkdirSync(dist,{recursive:true});
  const output = join(dist,'openai-plugin.zip');
  try {
    const info = lstatSync(output);
    if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error('ZIP output must be a regular unlinked file');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const bytes = zip(entries);
  writeFileSync(output,bytes);
  console.log(JSON.stringify({
    output,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),
    files:entries.map(e=>e.name)
  },null,2));
} catch (error) {
  console.error('Plugin packaging failed: ' + error.message);
  process.exitCode = 1;
}
