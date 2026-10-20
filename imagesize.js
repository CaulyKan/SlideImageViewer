'use strict';
// 只读文件开头的少量字节，从图片头部推断宽高。
// 好处：不用解码整张图，速度极快，打开文件夹时就能算出准确布局。
// 覆盖 png / jpeg / gif / webp / bmp / ico / svg / avif，其它格式返回 null 由调用方兜底。
const fs = require('fs');

const HEAD = 4096; // 常规格式的头部都在这个范围内

// 从 pos 处读最多 len 字节。文件比 len 短时返回实际读到的部分（小文件很常见）
function readAt(fd, pos, len) {
  const buf = Buffer.alloc(len);
  try {
    const got = fs.readSync(fd, buf, 0, len, pos);
    return got > 0 ? buf.subarray(0, got) : null;
  } catch {
    return null;
  }
}
const valid = (r) => (r && r.w > 0 && r.h > 0 ? { w: Math.round(r.w), h: Math.round(r.h) } : null);

// PNG：固定签名 + IHDR 块在固定位置
function parsePng(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return valid({ w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
}

// GIF：签名后紧跟逻辑屏宽高（小端 16 位）
function parseGif(b) {
  if (b.length < 10) return null;
  const sig = b.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return valid({ w: b.readUInt16LE(6), h: b.readUInt16LE(8) });
}

// BMP：文件头里的宽高（高可能是负数，表示自上而下存储）
function parseBmp(b) {
  if (b.length < 26 || b[0] !== 0x42 || b[1] !== 0x4d) return null;
  return valid({ w: Math.abs(b.readInt32LE(18)), h: Math.abs(b.readInt32LE(22)) });
}

// WebP：三种子格式（有损 / 无损 / 扩展）宽高位置各不相同
function parseWebp(b) {
  if (b.length < 16) return null;
  if (b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const fourcc = b.toString('latin1', 12, 16);
  if (fourcc === 'VP8 ') {
    if (b.length < 30) return null;
    return valid({ w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff });
  }
  if (fourcc === 'VP8L') {
    if (b.length < 25) return null;
    const bits = b.readUInt32LE(21); // 14 位宽-1、14 位高-1 打包在一个小端 32 位里
    return valid({ w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 });
  }
  if (fourcc === 'VP8X') {
    if (b.length < 30) return null;
    return valid({
      w: (b[24] | (b[25] << 8) | (b[26] << 16)) + 1,
      h: (b[27] | (b[28] << 8) | (b[29] << 16)) + 1,
    });
  }
  return null;
}

// ICO：取第一张图的尺寸，0 表示 256
function parseIco(b) {
  if (b.length < 16 || b.readUInt16LE(0) !== 0 || b.readUInt16LE(2) !== 1) return null;
  return valid({ w: b[6] || 256, h: b[7] || 256 });
}

// SVG：优先读 width/height 属性，其次读 viewBox
function parseSvg(b) {
  const txt = b.toString('utf8', 0, Math.min(b.length, 4096));
  if (!/<svg[\s>]/i.test(txt)) return null;
  const attr = (name) => {
    const m = txt.match(new RegExp(name + '\\s*=\\s*["\']\\s*([\\d.]+)', 'i'));
    return m ? parseFloat(m[1]) : null;
  };
  const w = attr('width'), h = attr('height');
  if (w && h) return valid({ w, h });
  const vb = txt.match(/viewBox\s*=\s*["\']\s*[-\d.]+\s+[-\d.]+\s+([\d.]+)\s+([\d.]+)/i);
  if (vb) return valid({ w: parseFloat(vb[1]), h: parseFloat(vb[2]) });
  return null;
}

// AVIF / HEIC：找 ispe 盒子
function parseAvif(b) {
  if (b.length < 32 || b.toString('latin1', 4, 8) !== 'ftyp') return null;
  const brand = b.toString('latin1', 8, 12);
  if (!['avif', 'avis', 'mif1', 'heic', 'heix'].includes(brand)) return null;
  const p = b.indexOf('ispe', 0, 'latin1');
  if (p < 0 || p + 16 > b.length) return null;
  return valid({ w: b.readUInt32BE(p + 8), h: b.readUInt32BE(p + 12) });
}

// JPEG：需要逐段扫描找到 SOF 标记；中途的 EXIF/ICC 大块直接跳过不读
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
function parseJpeg(fd, head) {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null;
  let pos = 2;
  for (let guard = 0; guard < 4096; guard++) {
    const seg = readAt(fd, pos, 4);
    if (!seg || seg.length < 4) return null;
    if (seg[0] !== 0xff) { pos++; continue; }              // 填充字节
    const marker = seg[1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    if (marker === 0xda) return null;                       // 已进入压缩数据，说明没有 SOF
    if (SOF_MARKERS.has(marker)) {
      const info = readAt(fd, pos + 2, 7);                  // 长度2 + 精度1 + 高2 + 宽2
      if (!info || info.length < 7) return null;
      return valid({ h: info.readUInt16BE(3), w: info.readUInt16BE(5) });
    }
    pos += 2 + seg.readUInt16BE(2);
  }
  return null;
}

// 返回 {w,h}，无法识别时返回 null
function readSize(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const head = readAt(fd, 0, HEAD) || Buffer.alloc(0);
    return (
      parsePng(head) || parseGif(head) || parseBmp(head) || parseWebp(head) ||
      parseIco(head) || parseSvg(head) || parseAvif(head) || parseJpeg(fd, head) || null
    );
  } catch {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* 忽略 */ } }
  }
}

module.exports = { readSize };
