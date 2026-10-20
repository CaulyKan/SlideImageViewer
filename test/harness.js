'use strict';
// 测试用的隐形窗口：渲染、动画、计时全都正常跑，但用户看不到、也点不到。
//
// 两个关键点：
// 1. 窗口用 1% 不透明度 + 不进任务栏 + 不抢焦点 + 鼠标穿透，做到实际不可见；
//    完全隐藏或全透明的窗口里，Chromium 会暂停图片动画和 rAF，测出来的东西是假的。
// 2. 必须关掉 Chromium 对"被遮挡/后台"窗口的降频 —— 否则窗口一旦被别的窗口盖住，
//    渲染和 rAF 会整个停掉，测试就会时好时坏。
const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');

app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

// 应用本身启动时会来问这几个，测试里给最小实现
function stubAppIpc(initPath) {
  ipcMain.handle('get-init-path', () => initPath);
  ipcMain.handle('open-file-dialog', () => null);
  ipcMain.handle('open-dir-dialog', () => null);
  ipcMain.handle('show-in-folder', () => {});
  ipcMain.handle('toggle-fullscreen', () => {});
}

function createInvisibleWindow({ width = 1280, height = 800, initPath = null } = {}) {
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    skipTaskbar: true,
    focusable: false,
    opacity: 0.01,
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.setIgnoreMouseEvents(true);
  win.showInactive();
  stubAppIpc(initPath);
  return win;
}

// 加载应用界面；传 page 可以加载别的页面（个别测试脚本需要）
const loadApp = (win, page) => win.loadFile(page || path.join(__dirname, '..', 'index.html'));

module.exports = { createInvisibleWindow, loadApp, stubAppIpc };
