// 主进程：负责创建窗口、系统对话框、以及把启动参数传给界面
const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron');
const fs = require('fs');
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

// ---------- 窗口状态记忆 ----------
// 默认最大化；之后记住上次关闭时的位置和大小，下次按原样恢复
function stateFile() {
  return path.join(app.getPath('userData'), 'window-state.json');
}

function loadWindowState() {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
    const b = s && s.bounds;
    if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite) || b.width < 200 || b.height < 200) return null;
    // 窗口至少要有一部分落在现在的某块屏幕里，防止拔掉显示器后窗口开到屏幕外找不到
    const visible = screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x + b.width > a.x + 60 && b.x < a.x + a.width - 60 &&
             b.y + b.height > a.y + 60 && b.y < a.y + a.height - 60;
    });
    if (!visible) return null;
    return s;
  } catch {
    return null; // 没有记录或读不出来，就用默认值
  }
}

function saveWindowState() {
  if (!win || win.isDestroyed()) return;
  try {
    // getNormalBounds 拿到的是"非最大化"时的尺寸，恢复时再按需最大化，不会把最大化尺寸当成普通尺寸
    fs.writeFileSync(stateFile(), JSON.stringify({
      bounds: win.getNormalBounds(),
      maximized: win.isMaximized(),
    }));
  } catch {
    // 存不上就算了，下次用默认值
  }
}

function createWindow() {
  const smoke = process.argv.includes('--smoke');
  const saved = loadWindowState();
  const opts = {
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
  };
  if (saved) {
    opts.x = saved.bounds.x;
    opts.y = saved.bounds.y;
    opts.width = saved.bounds.width;
    opts.height = saved.bounds.height;
  }

  win = new BrowserWindow(opts);
  // 第一次运行默认最大化；之后恢复上次的窗口状态
  if (saved ? !!saved.maximized : true) win.maximize();
  win.on('close', saveWindowState);

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
