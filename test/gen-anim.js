'use strict';
// 生成动画 WebP 测试素材：npx electron test/gen-anim.js
const { app, ipcMain } = require('electron');
const fs = require('fs');
const path = require('path');
const { createInvisibleWindow, loadApp } = require('./harness');

const outDir = path.join(__dirname, 'anim');
const COUNT = 40;

app.whenReady().then(() => {
  // 素材已经生成过就直接跳过，省得每次跑测试都重新编码一遍
  if (!process.argv.includes('--force') && fs.existsSync(outDir) &&
      fs.readdirSync(outDir).filter((f) => /^anim_\d+\.webp$/.test(f)).length >= COUNT) {
    console.log(`test/anim/ 里已有 ${COUNT} 张动画 WebP，跳过生成（要重新生成加 --force）`);
    app.exit(0);
    return;
  }
  const win = createInvisibleWindow({ width: 900, height: 700 });
  ipcMain.handle('get-cfg', () => ({ outDir }));
  // 兜底：无论如何 60 秒内必须结束，避免脚本挂住
  const bail = setTimeout(() => { console.log('[GEN] 超时未完成'); app.exit(1); }, 60000);
  win.webContents.on('console-message', (_e, _l, msg) => {
    if (!msg.startsWith('[GEN]')) return;
    clearTimeout(bail);
    const r = JSON.parse(msg.slice(5));
    if (r.error) { console.log('生成失败: ' + r.error); app.exit(1); return; }
    const sizeOk = r.readSize && r.readSize.w === 800 && r.readSize.h === 600;
    const decodeOk = r.decoded[0] === 800 && r.decoded[1] === 600;
    console.log(`已生成 ${r.count} 张动画 WebP 到 test/anim/（单张 ${r.bytes} 字节）`);
    console.log(`  canvas 静止图的数据块: ${r.stillChunks}`);
    console.log(`  Chromium 解码尺寸: ${r.decoded.join('x')} ${decodeOk ? 'OK' : '错!'}`);
    console.log(`  imagesize 读取尺寸: ${r.readSize ? r.readSize.w + 'x' + r.readSize.h : 'null'} ${sizeOk ? 'OK' : '错!'}`);
    // 下面这条仅供参考：隐形窗口里 Chromium 会暂停图片动画，这里必然测不出"画面在变"。
    // 素材是否合规由 test/verify-sizes.js（和 Chromium 解码结果对比）负责验证，不据此判定成败。
    console.log(`  （仅供参考）画面是否在变: ${r.animating ? '是' : '否（隐形窗口测不准，属正常）'}`);
    app.exit(sizeOk && decodeOk ? 0 : 1);
  });
  loadApp(win, path.join(__dirname, 'gen-anim.html'));
});
