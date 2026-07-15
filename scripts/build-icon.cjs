const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')

const scale = 4
const size = 256
const renderSize = size * scale
const pixels = Buffer.alloc(renderSize * renderSize * 4)
const projectRoot = path.resolve(__dirname, '..')

const rgba = (red, green, blue, alpha = 255) => [red, green, blue, alpha]
const mix = (from, to, amount) =>
  from.map((value, index) => Math.round(value + (to[index] - value) * amount))

function blendPixel(x, y, color) {
  if (x < 0 || y < 0 || x >= renderSize || y >= renderSize) return
  const offset = (y * renderSize + x) * 4
  const alpha = color[3] / 255
  const inverse = 1 - alpha
  pixels[offset] = Math.round(color[0] * alpha + pixels[offset] * inverse)
  pixels[offset + 1] = Math.round(color[1] * alpha + pixels[offset + 1] * inverse)
  pixels[offset + 2] = Math.round(color[2] * alpha + pixels[offset + 2] * inverse)
  pixels[offset + 3] = Math.round(255 * (alpha + (pixels[offset + 3] / 255) * inverse))
}

function insideRoundedRect(x, y, left, top, width, height, radius) {
  const right = left + width
  const bottom = top + height
  const nearestX = Math.max(left + radius, Math.min(x, right - radius))
  const nearestY = Math.max(top + radius, Math.min(y, bottom - radius))
  const dx = x - nearestX
  const dy = y - nearestY
  return x >= left && x <= right && y >= top && y <= bottom && dx * dx + dy * dy <= radius * radius
}

function drawDisc(centerX, centerY, radius, color) {
  const minX = Math.floor(centerX - radius)
  const maxX = Math.ceil(centerX + radius)
  const minY = Math.floor(centerY - radius)
  const maxY = Math.ceil(centerY + radius)
  const radiusSquared = radius * radius
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x + 0.5 - centerX
      const dy = y + 0.5 - centerY
      if (dx * dx + dy * dy <= radiusSquared) blendPixel(x, y, color)
    }
  }
}

function drawQuadratic(start, control, end, width, color) {
  const steps = 240
  for (let index = 0; index <= steps; index += 1) {
    const amount = index / steps
    const inverse = 1 - amount
    const x =
      inverse * inverse * start[0] +
      2 * inverse * amount * control[0] +
      amount * amount * end[0]
    const y =
      inverse * inverse * start[1] +
      2 * inverse * amount * control[1] +
      amount * amount * end[1]
    drawDisc(x, y, width / 2, color)
  }
}

function pointInsidePolygon(x, y, points) {
  let inside = false
  for (let current = 0, previous = points.length - 1; current < points.length; previous = current++) {
    const [currentX, currentY] = points[current]
    const [previousX, previousY] = points[previous]
    const intersects =
      currentY > y !== previousY > y &&
      x < ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX
    if (intersects) inside = !inside
  }
  return inside
}

function fillPolygon(points, colorAt) {
  const minX = Math.floor(Math.min(...points.map(([x]) => x)))
  const maxX = Math.ceil(Math.max(...points.map(([x]) => x)))
  const minY = Math.floor(Math.min(...points.map(([, y]) => y)))
  const maxY = Math.ceil(Math.max(...points.map(([, y]) => y)))
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (pointInsidePolygon(x + 0.5, y + 0.5, points)) {
        blendPixel(x, y, colorAt(x, y))
      }
    }
  }
}

const unit = (value) => value * scale
const backgroundStart = rgba(124, 108, 246)
const backgroundMiddle = rgba(85, 67, 216)
const backgroundEnd = rgba(24, 35, 58)

for (let y = 0; y < renderSize; y += 1) {
  for (let x = 0; x < renderSize; x += 1) {
    if (!insideRoundedRect(x, y, unit(9), unit(9), unit(238), unit(238), unit(60))) continue
    const amount = Math.max(0, Math.min(1, (x * 0.42 + y * 0.58 - unit(18)) / unit(222)))
    const color =
      amount < 0.52
        ? mix(backgroundStart, backgroundMiddle, amount / 0.52)
        : mix(backgroundMiddle, backgroundEnd, (amount - 0.52) / 0.48)
    blendPixel(x, y, color)
    const inner = insideRoundedRect(x, y, unit(16), unit(16), unit(224), unit(224), unit(54))
    if (!inner) blendPixel(x, y, rgba(255, 255, 255, 35))
  }
}

drawQuadratic(
  [unit(57), unit(150)],
  [unit(128), unit(224)],
  [unit(207), unit(156)],
  unit(9),
  rgba(183, 172, 255, 120)
)
drawDisc(unit(59), unit(150), unit(9.5), rgba(142, 232, 255))
drawDisc(unit(204), unit(156), unit(5.5), rgba(255, 255, 255, 220))

const mainStar = [
  [128, 53],
  [141, 102],
  [190, 115],
  [141, 128],
  [128, 177],
  [115, 128],
  [66, 115],
  [115, 102]
].map(([x, y]) => [unit(x), unit(y)])
fillPolygon(mainStar, (_x, y) =>
  mix(rgba(255, 255, 255), rgba(142, 232, 255), Math.max(0, Math.min(1, (y - unit(53)) / unit(124))))
)

const smallStar = [
  [169, 151],
  [176, 174],
  [199, 181],
  [176, 188],
  [169, 211],
  [162, 188],
  [139, 181],
  [162, 174]
].map(([x, y]) => [unit(x), unit(y)])
fillPolygon(smallStar, () => rgba(255, 255, 255, 232))

const downsampled = Buffer.alloc(size * size * 4)
for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    const totals = [0, 0, 0, 0]
    for (let sampleY = 0; sampleY < scale; sampleY += 1) {
      for (let sampleX = 0; sampleX < scale; sampleX += 1) {
        const sourceOffset =
          ((y * scale + sampleY) * renderSize + x * scale + sampleX) * 4
        totals[0] += pixels[sourceOffset]
        totals[1] += pixels[sourceOffset + 1]
        totals[2] += pixels[sourceOffset + 2]
        totals[3] += pixels[sourceOffset + 3]
      }
    }
    const targetOffset = (y * size + x) * 4
    const samples = scale * scale
    downsampled[targetOffset] = Math.round(totals[0] / samples)
    downsampled[targetOffset + 1] = Math.round(totals[1] / samples)
    downsampled[targetOffset + 2] = Math.round(totals[2] / samples)
    downsampled[targetOffset + 3] = Math.round(totals[3] / samples)
  }
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  }
  return value >>> 0
})

function crc32(buffer) {
  let value = 0xffffffff
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const name = Buffer.from(type)
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  name.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length)
  return chunk
}

const raw = Buffer.alloc((size * 4 + 1) * size)
for (let y = 0; y < size; y += 1) {
  const targetOffset = y * (size * 4 + 1)
  raw[targetOffset] = 0
  downsampled.copy(raw, targetOffset + 1, y * size * 4, (y + 1) * size * 4)
}

const header = Buffer.alloc(13)
header.writeUInt32BE(size, 0)
header.writeUInt32BE(size, 4)
header[8] = 8
header[9] = 6

const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  pngChunk('IHDR', header),
  pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  pngChunk('IEND', Buffer.alloc(0))
])

const icoHeader = Buffer.alloc(22)
icoHeader.writeUInt16LE(0, 0)
icoHeader.writeUInt16LE(1, 2)
icoHeader.writeUInt16LE(1, 4)
icoHeader.writeUInt8(0, 6)
icoHeader.writeUInt8(0, 7)
icoHeader.writeUInt8(0, 8)
icoHeader.writeUInt8(0, 9)
icoHeader.writeUInt16LE(1, 10)
icoHeader.writeUInt16LE(32, 12)
icoHeader.writeUInt32LE(png.length, 14)
icoHeader.writeUInt32LE(22, 18)

fs.writeFileSync(path.join(projectRoot, 'build', 'icon.png'), png)
fs.writeFileSync(path.join(projectRoot, 'build', 'icon.ico'), Buffer.concat([icoHeader, png]))
