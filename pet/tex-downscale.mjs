/**
 * 纯 Node 零依赖 PNG 降采样（Live2D 贴图专用）。
 *
 * 背景：B 站讨论指出「贴图 4096/8192 在网页渲染要降到 2048 试一次」——
 * WebGL 的 MAX_TEXTURE_SIZE 常见为 4096/8192，超限贴图会上传失败，
 * 表现为模型脸部/贴图异常。本模块在服务端把超大贴图缩到 <= maxSize，
 * 生成缓存供 runtime manifest 引用；原始模型目录只读，绝不改写。
 *
 * 实现：zlib inflate PNG IDAT → 逐行 unfilter（滚动两行，内存 O(width)）
 *       → 按整数比例采样 → 重新编码 PNG（filter 0）。仅支持 8bit RGB/RGBA，
 *       不满足时返回 null，调用方回退原图（不会更差）。
 */
import { inflateSync, deflateSync } from 'node:zlib'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'

const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

/** 读 PNG 尺寸（只读 IHDR） */
export async function pngSize(file) {
  const fh = await import('node:fs/promises').then(m => m.open(file, 'r'))
  try {
    const b = Buffer.alloc(26)
    await fh.read(b, 0, 26, 0)
    if (!b.subarray(0, 8).equals(SIG)) return null
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20), bitDepth: b[24], colorType: b[25] }
  } finally { await fh.close() }
}

/**
 * 把 src 降采样到最长边 <= maxSize，写到 dst。
 * @returns {Promise<{width,height,scale}|null>} null 表示不支持或有错误（调用方回退原图）
 */
export async function downscalePng(src, dst, maxSize) {
  const buf = await readFile(src)
  if (!buf.subarray(0, 8).equals(SIG)) return null
  let off = 8, idat = [], width = 0, height = 0, bitDepth = 0, colorType = 0
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off)
    const type = buf.toString('ascii', off + 4, off + 8)
    if (type === 'IHDR') {
      width = buf.readUInt32BE(off + 8); height = buf.readUInt32BE(off + 12)
      bitDepth = buf[off + 16]; colorType = buf[off + 17]
    } else if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len))
    else if (type === 'IEND') break
    off += 12 + len
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) return null
  if (width <= 0 || height <= 0 || !idat.length) return null
  if (Math.max(width, height) <= maxSize) return null // 不需要缩

  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length < height * (stride + 1)) return null

  const scale = Math.ceil(Math.max(width, height) / maxSize)
  const nw = Math.ceil(width / scale), nh = Math.ceil(height / scale)
  const outRows = []
  let prev = Buffer.alloc(stride), cur = Buffer.alloc(stride), p = 0
  for (let y = 0; y < height; y++) {
    const ft = raw[p++]
    for (let x = 0; x < stride; x++) {
      const v0 = raw[p + x]
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v
      if (ft === 0) v = v0
      else if (ft === 1) v = v0 + a
      else if (ft === 2) v = v0 + b
      else if (ft === 3) v = v0 + ((a + b) >> 1)
      else if (ft === 4) {
        const pp = a + b - c
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c)
        v = v0 + (pa <= pb && pa <= pc ? a : (pb <= pc ? b : c))
      } else return null
      cur[x] = v & 0xff
    }
    p += stride
    if (y % scale === 0) {
      const row = Buffer.alloc(nw * bpp + 1)
      row[0] = 0
      for (let x = 0; x < nw; x++) {
        const sx = Math.min(width - 1, x * scale) * bpp
        cur.copy(row, 1 + x * bpp, sx, sx + bpp)
      }
      outRows.push(row)
    }
    const t = prev; prev = cur; cur = t
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(nw, 0); ihdr.writeUInt32BE(nh, 4)
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const out = Buffer.concat([
    SIG, pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(outRows), { level: 6 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
  await mkdir(dirname(dst), { recursive: true })
  await writeFile(dst, out)
  return { width: nw, height: nh, scale }
}
