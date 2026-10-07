#!/usr/bin/env node
/**
 * Generate assets/icon.png (512×512) from the Kineticut AI bolt mark,
 * without any native rasterizer dependencies — pure pngjs pixel drawing.
 *
 *   npm run icon
 */
import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PNG } from 'pngjs'

const here = dirname(fileURLToPath(import.meta.url))
const outPath = join(here, '..', 'assets', 'icon.png')

const SIZE = 512
const RADIUS = 128 / 512 // matches icon.svg rx=128 @ 512

// Bolt polygon (from icon.svg path, scaled to 512 space).
const bolt = [
  [298, 72],
  [141, 291],
  [245, 291],
  [219, 440],
  [392, 221],
  [288, 221],
  [292, 72],
]

function lerp(a, b, t) {
  return Math.round(a + (b - a) * t)
}

function inRoundedRect(x, y) {
  const qx = Math.min(Math.max(x, RADIUS), SIZE - RADIUS)
  const qy = Math.min(Math.max(y, RADIUS), SIZE - RADIUS)
  const dx = x - qx
  const dy = y - qy
  return dx * dx + dy * dy <= RADIUS * RADIUS
}

function inPolygon(x, y) {
  let inside = false
  for (let i = 0, j = bolt.length - 1; i < bolt.length; j = i++) {
    const [xi, yi] = bolt[i]
    const [xj, yj] = bolt[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

const png = new PNG({ width: SIZE, height: SIZE })
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const idx = (SIZE * y + x) << 2
    if (!inRoundedRect(x + 0.5, y + 0.5)) {
      png.data[idx + 3] = 0 // transparent outside the rounded square
      continue
    }
    if (inPolygon(x + 0.5, y + 0.5)) {
      png.data[idx] = 255
      png.data[idx + 1] = 255
      png.data[idx + 2] = 255
      png.data[idx + 3] = 255
      continue
    }
    // Diagonal gradient #6d8dff → #9a7bff
    const t = (x + y) / (2 * SIZE)
    png.data[idx] = lerp(0x6d, 0x9a, t)
    png.data[idx + 1] = lerp(0x8d, 0x7b, t)
    png.data[idx + 2] = lerp(0xff, 0xff, t)
    png.data[idx + 3] = 255
  }
}

mkdirSync(dirname(outPath), { recursive: true })
png.pack().pipe(createWriteStream(outPath)).on('finish', () => {
  console.log(`✔ wrote ${outPath} (${SIZE}×${SIZE})`)
})
