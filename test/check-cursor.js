'use strict';
// 验证"鼠标指针自动隐藏"：用真实的鼠标事件 + 真实的 5 秒等待。
// 用法：npx electron test/check-cursor.js
const { app } = require('electron');
const path = require('path');
const { createInvisibleWindow, loadApp } = require('./harness');

// 用 41 张动图的文件夹，胶片足够长，5 秒内不会播到末尾（否则播放会自动停下，测不出隐藏）
const initPath = path.join(__dirname, 'anim', 'anim_00.webp');
const WAIT = 5600; // 比 5 秒阈值多留一点余量

app.whenReady().then(async () => {
  const win = createInvisibleWindow({ initPath });
  await loadApp(win);
  await new Promise((r) => setTimeout(r, 1500));

  const js = (code) => win.webContents.executeJavaScript(code);
  // 用真实的命中测试 + 真实事件派发，等价于鼠标真的在那个位置移动
  const move = (x, y) => js(`(() => {
    const el = document.elementFromPoint(${x}, ${y}) || document.body;
    el.dispatchEvent(new MouseEvent('mousemove', { clientX: ${x}, clientY: ${y}, bubbles: true }));
    return true;
  })()`);
  const click = (x, y) => js(`(() => {
    const el = document.elementFromPoint(${x}, ${y}) || document.body;
    el.dispatchEvent(new MouseEvent('mousedown', { clientX: ${x}, clientY: ${y}, bubbles: true }));
    return true;
  })()`);
  const state = () => js(`({
    hidden: strip.classList.contains('hide-cursor'),
    playing, mouseInImage,
    barShown: statusbar.classList.contains('show'),
  })`);
  // 真实的滚轮事件是打在鼠标下的元素上的，并且带坐标，这里照样模拟
  const play = () => js(`(() => {
    const el = document.elementFromPoint(640, 400) || document.body;
    for (let i = 0; i < 3; i++) {
      el.dispatchEvent(new WheelEvent('wheel', {
        deltaY: 120, deltaMode: 0, cancelable: true, bubbles: true, clientX: 640, clientY: 400,
      }));
    }
    return true;
  })()`);
  // 回到胶片开头再确认在播放：保证接下来这几秒不会播到末尾停下
  const ensurePlaying = async () => {
    await js('goToBlock(0, false); true');
    const s = await js('({ playing })');
    if (!s.playing) await play();
  };

  const results = [];
  const check = (name, ok, extra) => {
    results.push(ok);
    console.log(`  ${ok ? 'OK  ' : '错! '} ${name}${extra ? '  [' + extra + ']' : ''}`);
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const brief = (s) => `隐藏=${s.hidden} 播放中=${s.playing} 在图片区=${s.mouseInImage} 状态栏=${s.barShown}`;

  // ---- 1) 回归：只用滚轮起播，鼠标从头到尾没移动过 ----
  //       这正是真实使用中最常见的情形（打开图片后直接滚轮起播）。
  //       曾经 mouseInImage 初值为 false 且只在 mousemove 里更新，
  //       导致这种情况下指针永远不会隐藏。
  await play();
  await wait(WAIT);
  let s = await state();
  check('只滚轮起播、鼠标未移动也能隐藏', s.hidden && s.playing, brief(s));

  // ---- 2) 移动 → 立刻出现 ----
  await move(660, 420);
  s = await state();
  check('移动后指针出现', !s.hidden, brief(s));

  // ---- 3) 不动 5 秒 → 自动隐藏 ----
  await ensurePlaying();
  await wait(WAIT);
  s = await state();
  check(`不动 ${WAIT / 1000} 秒后自动隐藏`, s.hidden, brief(s));

  // ---- 4) 再不动 5 秒 → 隐藏；移到窗口最底部（图片区域外）→ 出现 ----
  await ensurePlaying();
  await wait(WAIT);
  s = await state();
  check('再次不动后隐藏', s.hidden, brief(s));
  await move(640, 795); // 最底部：属于图片区域外
  await move(640, 795); // 状态栏浮出后再动一次，命中测试才落在状态栏上
  s = await state();
  check('移到图片区域外（底部状态栏）指针出现', !s.hidden && s.barShown, brief(s));

  // ---- 5) 回图片区域不动 5 秒 → 隐藏；点击 → 出现 ----
  await move(640, 400);
  await ensurePlaying();
  await wait(WAIT);
  s = await state();
  check('回到图片区域不动后隐藏', s.hidden, brief(s));
  await click(640, 400);
  s = await state();
  check('点击后指针出现', !s.hidden, brief(s));

  // ---- 6) 暂停播放后不应该再隐藏 ----
  await js('if (playing) togglePlay(); true');
  await move(640, 400);
  await wait(WAIT);
  s = await state();
  check('暂停播放后指针保持可见', !s.hidden && !s.playing, brief(s));

  const pass = results.every(Boolean);
  console.log('');
  console.log(pass ? '全部通过 PASS' : '有失败项 FAIL');
  app.exit(pass ? 0 : 1);
}).catch((err) => {
  console.error('测试失败:', err);
  app.exit(1);
});
