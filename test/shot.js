'use strict';
// 离屏渲染截图：不开窗口也能出图，方便检查界面效果。
// 用法：npx electron test/shot.js --out shot.png test/images/b_04_orange.png
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const outPath = path.resolve(outIdx >= 0 ? args[outIdx + 1] : 'shot.png');
const imgArg = args.find((a, i) => i !== outIdx && i !== outIdx + 1 && !a.startsWith('--'));
const initPath = path.resolve(imgArg || 'test/images/a_01_red.png');

app.commandLine.appendSwitch('force-device-scale-factor', '1');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: { offscreen: true, nodeIntegration: true, contextIsolation: false },
  });
  // 渲染进程启动时会来问这几个，测试里给最小实现
  ipcMain.handle('get-init-path', () => initPath);
  ipcMain.handle('open-file-dialog', () => null);
  ipcMain.handle('open-dir-dialog', () => null);
  ipcMain.handle('show-in-folder', () => {});
  ipcMain.handle('toggle-fullscreen', () => {});

  await win.loadFile(path.join(__dirname, '..', 'index.html'));
  await new Promise((r) => setTimeout(r, 2500)); // 等图片加载和尺寸测量完成

  // 把鼠标移到窗口底部，让半透明状态栏浮现出来，一起截进去
  win.webContents.sendInputEvent({ type: 'mouseMove', x: 640, y: 792 });
  await new Promise((r) => setTimeout(r, 600));

  const img = await win.webContents.capturePage();
  fs.writeFileSync(outPath, img.toPNG());
  const s = img.getSize();
  console.log(`已保存截图 ${outPath}  ${s.width}x${s.height}`);
  app.exit(0);
});
