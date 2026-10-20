'use strict';
// 生成测试图片：7 张不同宽高比的纯色 PNG + 1 张两帧循环 GIF 动图
// 只用 Node 内置模块手写字节，不依赖任何第三方库
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const outDir = path.join(__dirname, 'images');
fs.mkdirSync(outDir, { recursive: true });

// ---------- PNG ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function makePng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;  // 每通道 8 位
  ihdr[9] = 2;  // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).fill(Buffer.from([r, g, b]))]);
  const raw = Buffer.concat(Array(h).fill(row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- GIF（两帧红蓝交替的循环动画） ----------
function packCodes(codes, codeLen) {
  // 按规范从最低位开始打包码流
  let bits = 0, nbits = 0;
  const out = [];
  for (const c of codes) {
    bits |= c << nbits;
    nbits += codeLen;
    while (nbits >= 8) { out.push(bits & 0xff); bits >>= 8; nbits -= 8; }
  }
  if (nbits > 0) out.push(bits & 0xff);
  return Buffer.from(out);
}
function subBlocks(data) {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) {
    const s = data.subarray(i, Math.min(i + 255, data.length));
    parts.push(Buffer.from([s.length]), s);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}
function gifFrame(colorIdx, w, h) {
  // 图像控制扩展（每帧停 20/100 秒）
  const gce = Buffer.from([0x21, 0xf9, 0x04, 0x00, 20, 0x00, 0x00, 0x00]);
  // 图像描述符：位置 0,0，无局部色表
  const desc = Buffer.alloc(9);
  desc[0] = 0x2c;
  desc.writeUInt16LE(w, 5);
  desc.writeUInt16LE(h, 7);
  const minCodeSize = 2; // 2 色，初始码长 3
  const clear = 4, eoi = 5;
  const codes = [clear, ...Array(w * h).fill(colorIdx), eoi];
  return Buffer.concat([gce, desc, Buffer.from([minCodeSize]), subBlocks(packCodes(codes, 3))]);
}
function makeGif(w, h) {
  const header = Buffer.from('GIF89a', 'ascii');
  const lsd = Buffer.alloc(7); // 逻辑屏：宽2 + 高2 + 标志1 + 背景色1 + 像素比1
  lsd.writeUInt16LE(w, 0);
  lsd.writeUInt16LE(h, 2);
  lsd[4] = 0x80; // 标志字节：置位"有全局色表"，色表大小 2 项
  const gct = Buffer.from([0xff, 0x00, 0x00, 0x00, 0x00, 0xff]); // 红、蓝
  const netscape = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'ascii'), 0x03, 0x01, 0x00, 0x00, 0x00]);
  const trailer = Buffer.from([0x3b]);
  return Buffer.concat([header, lsd, gct, netscape, gifFrame(0, w, h), gifFrame(1, w, h), trailer]);
}

// ---------- 生成 ----------
const pngs = [
  ['a_01_red.png', 800, 600, [255, 60, 60]],       // 4:3，正好算水平图
  ['a_02_blue.png', 640, 960, [60, 100, 255]],     // 竖图
  ['a_03_green.png', 1000, 700, [60, 200, 90]],    // 水平图
  ['a_04_yellow.png', 500, 500, [250, 220, 60]],   // 正方形
  ['b_02_purple.png', 1200, 800, [160, 80, 230]],  // 水平图
  ['b_03_cyan.png', 300, 900, [60, 220, 220]],     // 竖图
  ['b_04_orange.png', 900, 600, [255, 150, 40]],   // 水平图（与下一张连续，应堆叠）
  ['c_01_wide1.png', 1600, 600, [90, 90, 120]],    // 宽幅水平图（与上一张堆叠）
  ['c_02_wide2.png', 1400, 700, [200, 120, 170]],  // 宽幅水平图
];
for (const [name, w, h, rgb] of pngs) {
  fs.writeFileSync(path.join(outDir, name), makePng(w, h, rgb));
}
fs.writeFileSync(path.join(outDir, 'b_01_anim.gif'), makeGif(64, 64));
console.log('已生成 ' + (pngs.length + 1) + ' 张测试图片到 test/images/');
