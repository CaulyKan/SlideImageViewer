'use strict';
// 生成 build/icon.ico（256x256）。纯 Node 手写 PNG + ICO 字节，不依赖图形库。
// 图案：深色圆角方块 + 蓝色太阳 + 白色山峰（经典看图软件意象）
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 256;
const SS = 3; // 每个像素做 3x3 超采样，边缘更平滑

// ---------- 绘图基元 ----------
function inRoundRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), SIZE - r);
  const cy = Math.min(Math.max(y, r), SIZE - r);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}
function inTriangle(px, py, [x1, y1], [x2, y2], [x3, y3]) {
  const s = (ax, ay, bx, by, cx, cy) => (ax - cx) * (by - cy) - (bx - cx) * (ay - cy);
  const d1 = s(px, py, x1, y1, x2, y2);
  const d2 = s(px, py, x2, y2, x3, y3);
  const d3 = s(px, py, x3, y3, x1, y1);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

const mix = (a, b, t) => a + (b - a) * t;

// 单点取色，返回 [r,g,b,a]（a 为 0~255）
function sample(x, y) {
  if (!inRoundRect(x, y, 52)) return [0, 0, 0, 0];
  // 背景：从上到下的深色渐变
  const t = y / SIZE;
  let r = mix(0x2e, 0x11, t), g = mix(0x2e, 0x11, t), b = mix(0x3a, 0x18, t);

  // 太阳（先画，之后被山峰压住一部分）
  const sunR = 30, sunX = 172, sunY = 84;
  if ((x - sunX) ** 2 + (y - sunY) ** 2 <= sunR * sunR) {
    r = 0x7e; g = 0xc9; b = 0xff;
  }

  // 山峰
  const m = 0xec;
  if (inTriangle(x, y, [34, 196], [116, 88], [198, 196])) { r = m; g = m; b = 0xf2; }
  if (inTriangle(x, y, [124, 196], [178, 128], [232, 196])) { r = 0xd6; g = 0xd9; b = 0xe2; }

  // 底部地面
  if (y >= 196 && y <= 214) { r = 0x8a; g = 0x8f; b = 0xa0; }

  return [r, g, b, 255];
}

// 超采样生成 RGBA 像素
const px = Buffer.alloc(SIZE * SIZE * 4);
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0;
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const [sr, sg, sb, sa] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS);
        // 按 alpha 加权，避免透明边缘发黑
        r += sr * sa; g += sg * sa; b += sb * sa; a += sa;
      }
    }
    const cnt = SS * SS;
    const i = (y * SIZE + x) * 4;
    if (a > 0) { px[i] = Math.round(r / a); px[i + 1] = Math.round(g / a); px[i + 2] = Math.round(b / a); }
    px[i + 3] = Math.round(a / cnt);
  }
}

// ---------- PNG 编码（RGBA，颜色类型 6）----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // 每通道 8 位
ihdr[9] = 6;  // RGBA
const rawRows = [];
for (let y = 0; y < SIZE; y++) {
  rawRows.push(Buffer.from([0]), px.subarray(y * SIZE * 4, (y + 1) * SIZE * 4));
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(Buffer.concat(rawRows), { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

// ---------- 包成 ICO（256x256 用 PNG 压缩存储，Windows Vista 以上支持）----------
const dir = Buffer.alloc(16);
dir[0] = 0;   // 宽 256 记作 0
dir[1] = 0;   // 高 256 记作 0
dir[2] = 0;   // 调色板色数
dir[3] = 0;   // 保留
dir.writeUInt16LE(1, 4);       // 图像类型：图标
dir.writeUInt16LE(32, 6);      // 位深
dir.writeUInt32LE(png.length, 8);
dir.writeUInt32LE(22, 12);     // 数据偏移 = 6 + 16
const ico = Buffer.concat([
  Buffer.from([0, 0, 1, 0, 1, 0]), // ICO 头：1 张图
  dir,
  png,
]);

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), ico);
fs.writeFileSync(path.join(outDir, 'icon.png'), png); // 顺便存一份 PNG 备用
console.log(`已生成 build/icon.ico（${SIZE}x${SIZE}，${ico.length} 字节）`);
