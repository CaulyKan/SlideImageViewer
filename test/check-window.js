'use strict';
// 验证窗口状态记忆的机制：保存 → 恢复。
// 用隐藏窗口即可完成，不会弹出任何东西。用法：npx electron test/check-window.js
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const file = path.join(os.tmpdir(), 'iv-winstate-test.json');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 测试中途会销毁所有窗口，必须拦住 Electron 的默认"没有窗口就退出应用"
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const results = [];
  const check = (name, ok, extra) => {
    results.push(ok);
    console.log(`  ${ok ? 'OK  ' : '错! '} ${name}${extra ? '  [' + extra + ']' : ''}`);
  };

  // ---- 第一次：摆一个普通尺寸的窗口并最大化，按应用同样的方式保存 ----
  const w1 = new BrowserWindow({ width: 900, height: 600, show: false });
  w1.setBounds({ x: 123, y: 77, width: 1000, height: 700 });
  w1.maximize();
  await wait(250);
  const wasMaximized = w1.isMaximized();
  const normal1 = w1.getNormalBounds();
  fs.writeFileSync(file, JSON.stringify({ bounds: normal1, maximized: wasMaximized }));
  w1.destroy();

  check('最大化时 getNormalBounds 仍是普通尺寸',
    normal1.x === 123 && normal1.y === 77 && normal1.width === 1000 && normal1.height === 700,
    JSON.stringify(normal1));
  check('最大化状态被记住', wasMaximized === true);

  // ---- 第二次：按应用同样的方式恢复 ----
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const w2 = new BrowserWindow({
    show: false,
    x: saved.bounds.x, y: saved.bounds.y,
    width: saved.bounds.width, height: saved.bounds.height,
  });
  if (saved.maximized) w2.maximize();
  await wait(250);
  check('恢复后同样是最大化', w2.isMaximized() === true);
  const normal2 = w2.getNormalBounds();
  check('位置和尺寸原样恢复',
    normal2.x === normal1.x && normal2.y === normal1.y &&
    normal2.width === normal1.width && normal2.height === normal1.height,
    JSON.stringify(normal2));

  // ---- 边界情况：隐藏窗口也能最大化（自动测试依赖这一点）----
  const w3 = new BrowserWindow({ show: false });
  w3.maximize();
  await wait(250);
  check('隐藏窗口也能置为最大化', w3.isMaximized() === true);
  w3.destroy();

  try { fs.unlinkSync(file); } catch { /* 清理失败无所谓 */ }
  const pass = results.every(Boolean);
  console.log(pass ? '全部通过 PASS' : '有失败项 FAIL');
  await wait(300); // 等输出刷出去，app.exit 是立即终止，缓冲里的内容会丢
  app.exit(pass ? 0 : 1);
}).catch((e) => { console.error('测试失败:', e); app.exit(1); });
