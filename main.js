// 主进程：负责创建窗口、系统对话框、以及把启动参数传给界面
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');

let win = null;

// 从启动参数里找出可能的图片/文件夹路径（跳过 electron 自身和开关参数）
function argPath() {
  const argv = process.argv.slice(1);
  for (const a of argv) {
    if (a === '.' || a.startsWith('-')) continue;
    return path.resolve(a);
  }
  return null;
}

function createWindow() {
  const smoke = process.argv.includes('--smoke');
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#000000',
    autoHideMenuBar: true, // 隐藏菜单栏，把空间全部留给图片
    show: !smoke, // 冒烟测试时不弹出窗口，避免打扰
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false,
    },
  });

  win.loadFile('index.html', smoke ? { query: { smoke: '1' } } : undefined);

  win.webContents.on('context-menu', (e) => e.preventDefault()); // 右键菜单由页面自己画

  if (smoke) {
    // 冒烟测试：收集页面的自检结果，输出后自动退出
    const results = [];
    win.webContents.on('console-message', (_e, level, message) => {
      if (message.startsWith('[SMOKE]')) {
        results.push(message);
        console.log(message);
      }
    });
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        const pass = results.some((r) => r.includes('PASS')) && !results.some((r) => r.includes('FAIL'));
        console.log(pass ? '[SMOKE-RESULT] PASS' : '[SMOKE-RESULT] FAIL');
        app.exit(pass ? 0 : 1);
      }, 6000);
    });
  }
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());

// ---------- 供界面调用的系统功能 ----------

// 页面启动后询问"我是被哪个图片打开的"
ipcMain.handle('get-init-path', () => argPath());

// 打开图片文件选择框
ipcMain.handle('open-file-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '打开图片',
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

// 打开文件夹选择框
ipcMain.handle('open-dir-dialog', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '打开图片文件夹',
    properties: ['openDirectory'],
  });
  return r.canceled ? null : r.filePaths[0];
});

// 在资源管理器里定位当前文件
ipcMain.handle('show-in-folder', (_e, p) => shell.showItemInFolder(p));

// 全屏切换
ipcMain.handle('toggle-fullscreen', () => win.setFullScreen(!win.isFullScreen()));
