'use strict';
// 交叉验证 imagesize.js：拿 Chromium 自己解码出的尺寸当标准答案。
// 用法：npx electron test/verify-sizes.js   （窗口隐藏，不打扰用户）
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- 收集待测文件 ----------
const real = [];
const imgDir = path.join(__dirname, 'images');
if (fs.existsSync(imgDir)) {
  for (const f of fs.readdirSync(imgDir)) real.push(path.join(imgDir, f));
}
const animDir = path.join(__dirname, 'anim');
if (fs.existsSync(animDir)) {
  for (const f of fs.readdirSync(animDir)) real.push(path.join(animDir, f));
}
// 系统自带壁纸里有一批真实 JPEG，是验证 JPEG 分支最合适的素材
const WEB_DIR = 'C:\\Windows\\Web';
(function walk(d, depth) {
  if (depth > 3 || real.length >= 130) return;
  let ents = [];
  try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (real.length >= 130) return;
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (/\.(jpe?g|png|gif|bmp|webp)$/i.test(e.name)) real.push(p);
  }
})(WEB_DIR, 0);

// ---------- 手工构造 VP8L / VP8X 头（真实文件里较少见，按规范拼字节）----------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ivsize-'));
const synth = [];
const chunk = (fourcc, data) => {
  const size = Buffer.alloc(4);
  size.writeUInt32LE(data.length);
  return Buffer.concat([Buffer.from(fourcc, 'latin1'), size, data]);
};
const riff = (chunks) => {
  const body = Buffer.concat([Buffer.from('WEBP', 'latin1'), ...chunks]);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), head, body]);
};
{
  const w = 1024, h = 768; // VP8L：签名 0x2f + 14位宽-1 + 14位高-1 + 1位alpha + 3位版本
  const d = Buffer.alloc(5);
  d[0] = 0x2f;
  d.writeUInt32LE(((w - 1) | ((h - 1) << 14)) >>> 0, 1);
  const p = path.join(tmp, 'synth_vp8l.webp');
  fs.writeFileSync(p, riff([chunk('VP8L', d)]));
  synth.push({ p, w, h });
}
{
  const w = 4096, h = 2160; // VP8X：标志1 + 保留3 + 24位宽-1 + 24位高-1
  const d = Buffer.alloc(10);
  const put = (v, at) => { d[at] = v & 0xff; d[at + 1] = (v >> 8) & 0xff; d[at + 2] = (v >> 16) & 0xff; };
  put(w - 1, 4);
  put(h - 1, 7);
  const p = path.join(tmp, 'synth_vp8x.webp');
  fs.writeFileSync(p, riff([chunk('VP8X', d)]));
  synth.push({ p, w, h });
}

// ---------- 对比与报告 ----------
function report(out, syn) {
  let bad = 0, jpeg = 0, skipped = 0;
  const lines = [];
  for (const r of out) {
    const name = path.basename(r.p);
    if (!r.nat) { skipped++; continue; } // Chromium 解不开（例如构造文件）就跳过
    if (/\.jpe?g$/i.test(r.p)) jpeg++;
    const ok = r.got && r.got.w === r.nat[0] && r.got.h === r.nat[1];
    if (!ok) {
      bad++;
      lines.push(`  不一致 ${name}: 读到=${r.got ? r.got.w + 'x' + r.got.h : 'null'} Chromium=${r.nat.join('x')}`);
    }
  }
  for (const s of syn) {
    const ok = s.got && s.got.w === s.want[0] && s.got.h === s.want[1];
    if (!ok) {
      bad++;
      lines.push(`  不一致 ${path.basename(s.p)}: 读到=${s.got ? s.got.w + 'x' + s.got.h : 'null'} 期望=${s.want.join('x')}`);
    }
  }
  const checked = out.length - skipped + syn.length;
  console.log(`[VERIFY] 比对 ${checked} 个文件（其中真实 JPEG ${jpeg} 个，Chromium 解不开跳过 ${skipped} 个）`);
  for (const l of lines) console.log(l);
  console.log(bad === 0 ? '[VERIFY] 全部一致 PASS' : `[VERIFY] ${bad} 个不一致 FAIL`);
  app.exit(bad === 0 ? 0 : 1);
}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  ipcMain.handle('get-lists', () => ({ real, synth, tmp }));
  ipcMain.on('done', () => { /* 结果已在 console-message 里处理 */ });
  win.webContents.on('console-message', (_e, _lvl, msg) => {
    if (!msg.startsWith('[VERIFY]')) return;
    const { out, syn } = JSON.parse(msg.slice(8));
    report(out, syn);
  });
  win.loadFile(path.join(__dirname, 'verify.html'));
});
