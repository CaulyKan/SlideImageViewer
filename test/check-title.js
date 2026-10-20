'use strict';
// 验证标题栏：自动播放时标题要跟着更新，并带上进度 (xx/yy)
// 用法：npx electron test/check-title.js
const { app } = require('electron');
const path = require('path');
const { createInvisibleWindow, loadApp } = require('./harness');

const initPath = path.join(__dirname, 'anim', 'anim_00.webp');

app.whenReady().then(async () => {
  const win = createInvisibleWindow({ initPath });
  await loadApp(win);
  await new Promise((r) => setTimeout(r, 2000));

  const t0 = win.getTitle();
  console.log(`打开后标题: ${t0}`);

  // 用滚轮事件起播
  await win.webContents.executeJavaScript(
    `for (let i = 0; i < 3; i++) window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, cancelable: true })); true`
  );

  const seen = [t0];
  for (let i = 0; i < 5; i++) {
    await new Promise((r) => setTimeout(r, 900));
    const t = win.getTitle();
    if (t !== seen[seen.length - 1]) { seen.push(t); console.log(`播放中标题: ${t}`); }
  }

  const progressOk = seen.every((t) => /\(\d+(?:-\d+)?\/\d+\)/.test(t));
  const changed = seen.length > 1;
  console.log('');
  console.log(`  标题含"名称 + 进度": ${progressOk ? '是 OK' : '否 错!'}`);
  console.log(`  自动播放时标题会更新: ${changed ? `是 OK（共出现 ${seen.length} 种标题）` : '否 错!'}`);
  app.exit(progressOk && changed ? 0 : 1);
}).catch((err) => {
  console.error('测试失败:', err);
  app.exit(1);
});
