/**
 * Generate assets/icon-180.png (market storefront tile) from the same
 * artwork as icon.svg, without any image library: raw RGBA pixels + zlib.
 * Run: node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 180
const SCALE = SIZE / 64 // icon.svg viewBox is 64x64

// ---- PNG encoding ---------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---- drawing helpers (signed distance fields, 1px anti-aliasing) ----------
const clamp01 = v => Math.max(0, Math.min(1, v))
const coverage = sdf => clamp01(0.5 - sdf) // inside when sdf < 0

// Rounded rect SDF: distance to the core rect minus the corner radius.
function rrSdf(px, py, x0, y0, x1, y1, r) {
  const qx = Math.abs(px - (x0 + x1) / 2) - (x1 - x0) / 2 + r
  const qy = Math.abs(py - (y0 + y1) / 2) - (y1 - y0) / 2 + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
function capsuleSdf(px, py, ax, ay, bx, by, halfWidth) {
  const abx = bx - ax
  const aby = by - ay
  const t = clamp01(((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby || 1))
  return Math.hypot(px - (ax + abx * t), py - (ay + aby * t)) - halfWidth
}
const lerp = (a, b, t) => a + (b - a) * t
const hex = h => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const C1 = hex('#4f7cff')
const C2 = hex('#7a5cff')

// ---- artwork (same geometry as icon.svg, scaled) --------------------------
const bars = [
  [12, 32, 12, 32.1],
  [19, 26, 19, 38],
  [26, 20, 26, 44],
  [33, 15, 33, 49],
  [40, 22, 40, 42],
  [47, 27, 47, 37],
  [54, 32, 54, 32.1]
].map(([ax, ay, bx, by]) => [ax * SCALE, ay * SCALE, bx * SCALE, by * SCALE])
const halfWidth = (3.4 / 2) * SCALE
const dot = { x: 33 * SCALE, y: 32 * SCALE, r: 2.6 * SCALE }

const rgba = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5
    const py = y + 0.5
    const bgCov = coverage(rrSdf(px, py, 2 * SCALE, 2 * SCALE, 62 * SCALE, 62 * SCALE, 14 * SCALE))
    let r = 0
    let g = 0
    let b = 0
    let a = 0
    if (bgCov > 0) {
      const t = (px + py) / (2 * SIZE)
      r = lerp(C1[0], C2[0], t)
      g = lerp(C1[1], C2[1], t)
      b = lerp(C1[2], C2[2], t)
      a = bgCov * 255
    }
    let markCov = coverage(Math.hypot(px - dot.x, py - dot.y) - dot.r)
    for (const [ax, ay, bx, by] of bars) {
      markCov = Math.max(markCov, coverage(capsuleSdf(px, py, ax, ay, bx, by, halfWidth)))
    }
    if (markCov > 0) {
      // white mark over the gradient (or over transparency at the edges)
      r = lerp(r, 255, markCov)
      g = lerp(g, 255, markCov)
      b = lerp(b, 255, markCov)
      a = Math.max(a, markCov * 255)
    }
    const i = (y * SIZE + x) * 4
    rgba[i] = Math.round(r)
    rgba[i + 1] = Math.round(g)
    rgba[i + 2] = Math.round(b)
    rgba[i + 3] = Math.round(a)
  }
}

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icon-180.png')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, encodePng(SIZE, SIZE, rgba))
console.log(`wrote ${out} (${SIZE}x${SIZE})`)