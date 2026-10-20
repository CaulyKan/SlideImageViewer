'use strict';
// 界面逻辑：分块平铺布局（含水平图上下堆叠）、滚轮自动播放、状态栏、右键菜单
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ipcRenderer } = require('electron');
const { readSize } = require('./imagesize');

// ---------- 常量 ----------
const IMG_EXTS = new Set(['jpg', 'jpeg', 'jfif', 'png', 'gif', 'webp', 'bmp', 'avif', 'svg', 'ico']);
const BASE_SPEED = 600;        // 基准速度（像素/秒），显示为 1.0x
const SPEED_STEP = 120;        // 滚轮每格调节量（0.2x）
const MAX_SPEED = 6000;
const MIN_SPEED = -6000;
const LANDSCAPE_RATIO = 4 / 3; // 宽高比 >= 4:3 视为水平图
const UNKNOWN_RATIO = 1;       // 尺寸读不出来时的估计比例
const GAP = 2;                 // 上下堆叠时两张图之间的缝隙
// 只有视口附近的图片才真正参与绘制（动图也才会解码播放）。
// 视口外的图片仍留在内存里但停止绘制，滚回来瞬间就能显示，不用重新解码。
const SHOW_PAD = 0.01;         // 视口外只多显示一点点（防边缘取整误差）
const KEEP_PAD = 2;            // 保留在内存里的预加载范围：视口左右各 2 屏
const SCAN_WINDOW = 30;        // 打开文件夹时，同步读尺寸的范围：起点前后各 30 张
const MEASURE_BUDGET = 3;      // 没有空闲时间回调时，每次最多读几张的文件头（别和播放抢 CPU）

// 复用同一个排序器实例。实测比 localeCompare 带选项快 30 倍，排序结果完全一致
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// ---------- DOM ----------
const strip = document.getElementById('strip');
const track = document.getElementById('track');
const emptyEl = document.getElementById('empty');
const speedHint = document.getElementById('speed-hint');
const statusbar = document.getElementById('statusbar');
const sbName = document.getElementById('sb-name');
const sbIndex = document.getElementById('sb-index');
const sbSpeed = document.getElementById('sb-speed');
const sbTrack = document.getElementById('sb-track');
const sbProgress = document.getElementById('sb-progress');
const sbThumb = document.getElementById('sb-thumb');
const ctxmenu = document.getElementById('ctxmenu');
const chkStack = document.getElementById('chk-stack');

// ---------- 状态 ----------
let dir = null;               // 当前文件夹
let files = [];               // 排好序的图片文件名
let n = 0;
let sizes = new Map();        // 文件名 -> {ratio}
let blocks = [];              // 分块：一块是一张图，或上下堆叠的两张水平图
let xs = new Float64Array(1); // 各块左端位置的前缀和，xs[b] 是第 b 块的左端
let totalW = 0;
let blockOfImage = new Int32Array(1); // 图片序号 -> 所属块
let stackEnabled = true;      // 水平图上下堆叠开关
let vw = innerWidth || 1280;  // 窗口隐藏时 innerWidth 可能为 0，给个兜底值
let H = innerHeight || 820;
let offset = 0;               // 视口左端在布局中的位置
let speed = 0;                // 速度表：正数 = 内容左移（往后看），负数 = 反向。
                              // 从 0 起步，所以第一次向下滚轮是 0.2x，而不是叠在 1.0x 上变成 1.2x
let playing = false;
let anim = null;              // 平滑滚动动画 {from,to,t0,dur}
let dragging = false;
let seeking = false;
let xsDirty = false;
let gen = 0;                  // 打开次数，用于丢弃过期的异步任务
let measureQueue = [];        // 待测尺寸的图片序号（后台慢慢补）
const inQueue = new Set();    // 上面队列的成员，用于去重
const hot = new Set();        // 马上要滚到眼前的，优先测
let pumpScheduled = false;
let layoutVersion = 0;        // 布局版本，变化时元素的尺寸位置需要重写一次

// 渲染池：图片序号 -> {el, x, y, w, h, shown, ver}
// 每张图在整条胶片里只出现一次，所以按图片序号索引即可
const pool = new Map();

// ---------- 工具 ----------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const ratioOf = (i) => sizes.get(files[i])?.ratio ?? UNKNOWN_RATIO;
const urlOf = (i) => pathToFileURL(path.join(dir, files[i])).href;

// ---------- 布局 ----------
// 扫描整个文件夹：连续两张水平图合成一块（上下堆叠），其余各自成块
function rebuildLayout() {
  blocks = [];
  const halfH = (H - GAP) / 2;
  let i = 0;
  while (i < n) {
    const r0 = ratioOf(i);
    if (stackEnabled && r0 >= LANDSCAPE_RATIO && i + 1 < n && ratioOf(i + 1) >= LANDSCAPE_RATIO) {
      const r1 = ratioOf(i + 1);
      const w0 = r0 * halfH, w1 = r1 * halfH;
      const w = Math.max(w0, w1); // 块宽取两张里较宽的那张，两张各自居中
      blocks.push({
        imgs: [i, i + 1],
        w,
        cells: [
          { i, x: (w - w0) / 2, y: 0, w: w0, h: halfH },
          { i: i + 1, x: (w - w1) / 2, y: halfH + GAP, w: w1, h: halfH },
        ],
      });
      i += 2;
    } else {
      const w = r0 * H;
      blocks.push({ imgs: [i], w, cells: [{ i, x: 0, y: 0, w, h: H }] });
      i += 1;
    }
  }
  xs = new Float64Array(blocks.length + 1);
  for (let b = 0; b < blocks.length; b++) xs[b + 1] = xs[b] + blocks[b].w;
  totalW = xs[blocks.length];
  blockOfImage = new Int32Array(Math.max(1, n));
  blocks.forEach((blk, b) => { for (const img of blk.imgs) blockOfImage[img] = b; });
  xsDirty = false;
  layoutVersion++;
}

// 二分：返回 b 使 xs[b] <= x < xs[b+1]
function indexAtBlock(x) {
  let lo = 0, hi = blocks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (xs[mid] <= x) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// 视口中心落在哪一块
function currentBlockIndex() {
  if (!blocks.length) return 0;
  const c = clamp(offset + vw / 2, 0, Math.max(0, totalW - 1e-6));
  return indexAtBlock(c);
}

// 视口中心落在哪张图（堆叠块取上面那张，因为两张同时可见）
function currentImageIndex() {
  const blk = blocks[currentBlockIndex()];
  return blk ? blk.imgs[0] : 0;
}

// 让第 b 块居中所需的 offset
function offsetToCenterBlock(b) {
  const blk = blocks[clamp(b, 0, blocks.length - 1)];
  if (!blk) return offset;
  return xs[clamp(b, 0, blocks.length - 1)] + blk.w / 2 - vw / 2;
}

// 限制偏移范围：两头允许把首/末一块居中（必要时露出黑边），同时保证整条内容都能看全
function normalizeOffset() {
  if (!blocks.length) return;
  if (totalW <= vw) {
    offset = -(vw - totalW) / 2;
    if (playing) playing = false;
    return;
  }
  const min = Math.min(offsetToCenterBlock(0), 0);
  const max = Math.max(offsetToCenterBlock(blocks.length - 1), totalW - vw);
  if (offset <= min) {
    offset = min;
    if (playing && speed < 0) { playing = false; showHint('已到开头'); }
  } else if (offset >= max) {
    offset = max;
    if (playing && speed > 0) { playing = false; showHint('已到末尾'); }
  }
}

// ---------- 渲染 ----------
// 元素在容器内的位置是固定的，整条胶片靠容器的一次 transform 平移，
// 所以这里只在滚动/布局变化时增删元素、切换显示状态，不做逐帧样式写入。
function placeElement(rec, absX, cell) {
  rec.x = absX; rec.y = cell.y; rec.w = cell.w; rec.h = cell.h;
  rec.el.style.width = cell.w + 'px';
  rec.el.style.height = cell.h + 'px';
  rec.el.style.transform = `translate(${absX}px, ${cell.y}px)`;
  rec.ver = layoutVersion;
}

function syncPool() {
  if (!blocks.length) return;
  const showFrom = offset - SHOW_PAD * vw;
  const showTo = offset + (1 + SHOW_PAD) * vw;
  const keepFrom = Math.max(offset - KEEP_PAD * vw, 0);
  const keepTo = Math.min(offset + (1 + KEEP_PAD) * vw, totalW);
  const live = new Set();

  if (keepFrom < keepTo) {
    for (let b = indexAtBlock(keepFrom); b < blocks.length && xs[b] < keepTo; b++) {
      const blk = blocks[b];
      for (const cell of blk.cells) {
        const i = cell.i;
        live.add(i);
        let rec = pool.get(i);
        if (!rec) {
          const el = document.createElement('img');
          el.draggable = false;
          el.src = urlOf(i);
          track.appendChild(el);
          rec = { el, x: 0, y: 0, w: 0, h: 0, shown: null, ver: -1 };
          pool.set(i, rec);
          // 这张马上要看到了，尺寸还没测出来的话让它插队
          if (!sizes.has(files[i])) prioritize(i);
        }
        const absX = xs[b] + cell.x;
        if (rec.ver !== layoutVersion) placeElement(rec, absX, cell);
        // 只有真正在视口里的图片才显示 —— 视口外的动图会因此停止解码播放
        const want = absX < showTo && absX + cell.w > showFrom;
        if (rec.shown !== want) {
          rec.shown = want;
          rec.el.style.display = want ? '' : 'none';
        }
      }
    }
  }
  // 超出预加载范围的元素移除，控制内存占用
  for (const [i, rec] of pool) {
    if (!live.has(i)) { rec.el.remove(); pool.delete(i); }
  }
}

let lastSyncKey = '';
function maybeSyncPool() {
  const key = Math.round(offset) + '|' + vw + '|' + H + '|' + layoutVersion;
  if (key === lastSyncKey) return;
  lastSyncKey = key;
  syncPool();
}

let lastTrackX = null;
function moveTrack() {
  const x = Math.round(-offset); // 取整可以让合成器直接平移纹理，避免每帧重采样
  if (x === lastTrackX) return;
  lastTrackX = x;
  track.style.transform = `translate3d(${x}px, 0, 0)`;
}

function resetRender() {
  pool.forEach((rec) => rec.el.remove());
  pool.clear();
  lastSyncKey = '';
  lastTrackX = null;
}

// ---------- 状态栏与标题栏 ----------
// 只在内容真的变了的时候才写 DOM，避免每帧都触发文字排版
let lastHudKey = '';
let lastSpeedText = '';
function updateHud() {
  const blk = blocks[currentBlockIndex()];
  if (!blk) return;
  const first = blk.imgs[0];
  const last = blk.imgs[blk.imgs.length - 1];
  const key = first + '-' + last;
  if (key !== lastHudKey) {
    lastHudKey = key;
    const idxText = blk.imgs.length > 1 ? `${first + 1}-${last + 1}` : `${first + 1}`;
    const names = blk.imgs.map((i) => files[i]);
    sbName.textContent = names.join('  +  ');
    sbIndex.textContent = idxText + ` / ${n}`;
    // 标题栏同步显示当前图片名和进度（自动播放时也会跟着走）
    document.title = names.join(' + ') + ` (${idxText}/${n}) - SlideImageViewer`;
    // 进度条按"当前图在文件夹中的位置"显示
    const frac = n > 1 ? first / (n - 1) : 0;
    sbProgress.style.width = (frac * 100) + '%';
    sbThumb.style.left = (frac * 100) + '%';
  }
  const sp = speed / BASE_SPEED;
  const text = (playing ? '' : '⏸ ') + (sp < 0 ? '-' : '') + Math.abs(sp).toFixed(1) + 'x';
  if (text !== lastSpeedText) {
    lastSpeedText = text;
    sbSpeed.textContent = text;
  }
}

let hintTimer = 0;
function showHint(text) {
  speedHint.textContent = text;
  speedHint.classList.add('show');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => speedHint.classList.remove('show'), 900);
}

// ---------- 播放控制 ----------
function setSpeedDelta(d) {
  speed = clamp(speed + d, MIN_SPEED, MAX_SPEED);
  playing = true;
  anim = null;
  const sp = speed / BASE_SPEED;
  showHint((sp < 0 ? '-' : '') + Math.abs(sp).toFixed(1) + 'x');
}

function togglePlay() {
  if (!n) return;
  playing = !playing;
  if (playing && speed === 0) speed = BASE_SPEED;
  anim = null;
  showHint(playing ? '▶ ' + Math.abs(speed / BASE_SPEED).toFixed(1) + 'x' : '⏸ 暂停');
}

// 跳到第 b 块并居中
function goToBlock(b, animate) {
  if (!blocks.length) return;
  const target = offsetToCenterBlock(clamp(b, 0, blocks.length - 1));
  if (animate) anim = { from: offset, to: target, t0: performance.now(), dur: 320 };
  else { offset = target; anim = null; }
  normalizeOffset();
}

function stepBlock(d) { // d: +1 下一块, -1 上一块
  if (!blocks.length) return;
  goToBlock(currentBlockIndex() + d, true);
}

// 按进度条比例跳转（f 为 0~1，对应文件夹中的位置）
function seekToFraction(f) {
  if (!n) return;
  const j = Math.round(clamp(f, 0, 1) * (n - 1));
  goToBlock(blockOfImage[j], false);
}

// ---------- 主循环 ----------
let lastT = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  advance(dt);
  maybeSyncPool();
  moveTrack();
  updateHud();
  syncCursor();
  requestAnimationFrame(tick);
}

// 推进一帧（独立出来便于自动测试）
function advance(dt) {
  if (!n || !blocks.length) return;
  if (xsDirty) {
    // 后台测出新尺寸后重新分块：按"当前图 + 块内相对位置"锚定，画面不漂移
    const b = currentBlockIndex();
    const blk = blocks[b];
    const rel = blk && blk.w ? clamp((offset + vw / 2 - xs[b]) / blk.w, 0, 1) : 0.5;
    const anchorImg = blk ? blk.imgs[0] : 0;
    rebuildLayout();
    const b2 = blockOfImage[Math.min(anchorImg, n - 1)];
    const blk2 = blocks[b2];
    if (blk2) offset = xs[b2] + rel * blk2.w - vw / 2;
  }
  if (anim) {
    const t = clamp((performance.now() - anim.t0) / anim.dur, 0, 1);
    offset = anim.from + (anim.to - anim.from) * easeInOut(t);
    if (t >= 1) anim = null;
  } else if (!dragging && !seeking && playing) {
    offset += speed * dt;
  }
  normalizeOffset();
}

requestAnimationFrame(tick);

// ---------- 尺寸读取 ----------
// 打开文件夹时只同步读取"起点前后各若干张"的尺寸，保证首屏和附近布局准确。
// 其余几千张交给后台空闲时间慢慢补 —— 关键是绝不能在这里把主线程堵住。
function scanSizes(list, targetDir, center) {
  sizes = new Map();
  const from = Math.max(0, center - SCAN_WINDOW);
  const to = Math.min(list.length, center + SCAN_WINDOW + 1);
  for (let i = from; i < to; i++) {
    const s = readSize(path.join(targetDir, list[i]));
    if (s) sizes.set(list[i], { ratio: s.w / s.h });
  }
}

function enqueueMeasure(myGen) {
  if (myGen !== gen) return;
  measureQueue = [];
  inQueue.clear();
  hot.clear();
  for (let i = 0; i < files.length; i++) {
    if (!sizes.has(files[i])) { measureQueue.push(i); inQueue.add(i); }
  }
  schedulePump();
}

// 某张图马上要进视口附近了，插队优先测
function prioritize(i) {
  if (sizes.has(files[i]) || !inQueue.has(i) || hot.has(i)) return;
  hot.add(i);
  schedulePump();
}

function schedulePump() {
  if (pumpScheduled) return; // 已经排好了，那一次回调会接着往下跑
  pumpScheduled = true;
  const run = (deadline) => {
    pumpScheduled = false;
    pumpMeasure(gen, deadline || null); // 用当前代次，避免刚换文件夹时这次调度被丢弃
  };
  // 优先用浏览器空闲时间做这件事，完全不影响滚动和播放
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 300 });
  else setTimeout(() => run(null), 0);
}

function pumpMeasure(myGen, deadline) {
  if (myGen !== gen) return;
  let budget = MEASURE_BUDGET;
  for (;;) {
    if (deadline && !deadline.didTimeout) { if (deadline.timeRemaining() < 1) break; }
    else if (budget-- <= 0) break;

    let i;
    if (hot.size) { i = hot.values().next().value; hot.delete(i); }
    else if (measureQueue.length) { i = measureQueue.shift(); inQueue.delete(i); }
    else break;

    const name = files[i];
    if (!name || sizes.has(name)) continue;
    const s = readSize(path.join(dir, name));   // 只读文件头，很便宜
    if (s) { sizes.set(name, { ratio: s.w / s.h }); xsDirty = true; continue; }

    // 文件头认不出来的格式，退回真正解码一次（异步，不阻塞主线程）
    const img = new Image();
    img.onload = () => {
      if (myGen !== gen) return;
      if (img.naturalWidth > 0) { sizes.set(name, { ratio: img.naturalWidth / img.naturalHeight }); xsDirty = true; }
    };
    img.onerror = () => { if (myGen === gen) { sizes.set(name, { ratio: UNKNOWN_RATIO }); xsDirty = true; } };
    img.src = urlOf(i);
  }
  if (hot.size || measureQueue.length) schedulePump();
}

// ---------- 打开文件/文件夹 ----------
function openPath(p) {
  try {
    const stat = fs.statSync(p);
    let targetDir, focusFile = null;
    if (stat.isDirectory()) {
      targetDir = p;
    } else {
      targetDir = path.dirname(p);
      focusFile = path.basename(p);
    }
    // 用 readdir 自带的目录项类型判断是不是文件，避免对每个文件再 stat 一次
    // （实测 5000 个文件从 131ms 降到 4ms）
    const list = fs.readdirSync(targetDir, { withFileTypes: true })
      .filter((e) => {
        const ext = path.extname(e.name).slice(1).toLowerCase();
        if (!IMG_EXTS.has(ext)) return false;
        if (e.isFile()) return true;
        // 软链接很少见，稳妥起见才真的 stat 一次
        if (e.isSymbolicLink()) {
          try { return fs.statSync(path.join(targetDir, e.name)).isFile(); } catch { return false; }
        }
        return false;
      })
      .map((e) => e.name)
      .sort((a, b) => nameCollator.compare(a, b));

    gen++;
    dir = targetDir;
    files = list;
    n = list.length;
    resetRender();
    anim = null;
    playing = false;
    speed = 0;   // 速度表归零，第一次滚轮从 0.2x 起步
    lastHudKey = '';
    measureQueue = [];
    inQueue.clear();
    hot.clear();

    // 先定出要看哪一张，再只读它附近的尺寸 —— 这是首屏能秒开的关键
    const start = focusFile ? Math.max(0, files.indexOf(focusFile)) : 0;
    scanSizes(list, targetDir, start);
    rebuildLayout();

    if (n) {
      emptyEl.classList.add('hidden');
      offset = offsetToCenterBlock(blockOfImage[start]);
      normalizeOffset();
      syncPool();   // 立刻铺好首屏，不用等下一帧
      moveTrack();
      if (n > sizes.size) enqueueMeasure(gen);   // 剩下的尺寸等首屏画完再慢慢补
    } else {
      emptyEl.querySelector('.empty-text').textContent = '这个文件夹里没有图片';
      emptyEl.classList.remove('hidden');
    }
    updateHud();
  } catch (err) {
    console.error('打开失败:', err);
  }
}

// ---------- 事件：滚轮（触发播放 + 调速） ----------
window.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (!n) return;
  const unit = e.deltaMode === 1 ? e.deltaY / 3 : e.deltaY / 100; // 归一化，鼠标/触控板都顺手
  const dirMag = Math.sign(unit) * Math.max(1, Math.abs(unit));
  setSpeedDelta(SPEED_STEP * dirMag);
}, { passive: false });

// ---------- 事件：键盘 ----------
window.addEventListener('keydown', (e) => {
  if (e.key === ' ') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowRight') stepBlock(+1);
  else if (e.key === 'ArrowLeft') stepBlock(-1);
  else if (e.key === 'Home') goToBlock(0, true);
  else if (e.key === 'End') goToBlock(blocks.length - 1, true);
  else if (e.key === '+' || e.key === '=') setSpeedDelta(+SPEED_STEP);
  else if (e.key === '-' || e.key === '_') setSpeedDelta(-SPEED_STEP);
  else if (e.key === 'F11') { e.preventDefault(); ipcRenderer.invoke('toggle-fullscreen'); }
  else if (e.key === 'o' && e.ctrlKey) { e.preventDefault(); openFileDlg(); }
  else if (e.key === 'Escape') hideMenu();
});

// ---------- 事件：鼠标拖拽平移 ----------
strip.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !n) return;
  dragging = true;
  anim = null;
  strip.classList.add('dragging');
  const startX = e.clientX, startOffset = offset;
  const onMove = (ev) => { offset = startOffset - (ev.clientX - startX); normalizeOffset(); };
  const onUp = () => {
    dragging = false;
    strip.classList.remove('dragging');
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
});

// ---------- 鼠标指针自动隐藏 ----------
// 自动播放时，鼠标停在图片区域不动满 5 秒就把指针藏起来，免得挡着看图；
// 一动、一点击，或者移到图片区域外（底部状态栏、右键菜单）就立刻显示出来。
const CURSOR_IDLE_MS = 5000;
let cursorTimer = 0;
let cursorHidden = false;
let mouseInImage = false;

function showCursor() {
  clearTimeout(cursorTimer);
  cursorTimer = 0;
  if (cursorHidden) {
    cursorHidden = false;
    strip.classList.remove('hide-cursor');
  }
}

function scheduleCursorHide() {
  clearTimeout(cursorTimer);
  cursorTimer = setTimeout(() => {
    cursorTimer = 0;
    if (playing && mouseInImage) {
      cursorHidden = true;
      strip.classList.add('hide-cursor');
    }
  }, CURSOR_IDLE_MS);
}

// 每帧核对一次：暂停播放、或鼠标不在图片区域时，指针必须保持可见
function syncCursor() {
  if (!playing || !mouseInImage) { showCursor(); return; }
  if (!cursorTimer && !cursorHidden) scheduleCursorHide();
}

// ---------- 事件：状态栏显隐 ----------
// 窗口底部这条区域算"图片区域外"：鼠标进到这里会浮出状态栏，指针也保持可见
const STATUS_ZONE = 52;

window.addEventListener('mousemove', (e) => {
  const nearBottom = e.clientY >= innerHeight - STATUS_ZONE;
  statusbar.classList.toggle('show', nearBottom);
  const inImage = !nearBottom && !ctxmenu.contains(e.target);
  mouseInImage = inImage;
  showCursor();                                   // 一动就先让指针出现
  if (playing && inImage) scheduleCursorHide();   // 然后重新开始 5 秒计时
});
window.addEventListener('mouseleave', () => {
  statusbar.classList.remove('show');
  mouseInImage = false;
  showCursor();
});
window.addEventListener('mousedown', showCursor);

// ---------- 事件：进度条点击/拖动 ----------
function fracFromEvent(e) {
  const r = sbTrack.getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1);
}
sbTrack.addEventListener('pointerdown', (e) => {
  if (!n) return;
  e.preventDefault();
  seeking = true;
  anim = null;
  sbTrack.setPointerCapture(e.pointerId);
  const apply = (ev) => seekToFraction(fracFromEvent(ev));
  apply(e);
  const onMove = (ev) => apply(ev);
  const onUp = () => {
    seeking = false;
    sbTrack.removeEventListener('pointermove', onMove);
    sbTrack.removeEventListener('pointerup', onUp);
  };
  sbTrack.addEventListener('pointermove', onMove);
  sbTrack.addEventListener('pointerup', onUp);
});

// ---------- 事件：右键菜单 ----------
function showMenu(x, y) {
  ctxmenu.querySelector('[data-act="toggle"]').firstChild.textContent = playing ? '暂停' : '播放';
  chkStack.classList.toggle('on', stackEnabled);
  ctxmenu.classList.add('show');
  const mw = ctxmenu.offsetWidth, mh = ctxmenu.offsetHeight;
  ctxmenu.style.left = Math.min(x, innerWidth - mw - 6) + 'px';
  ctxmenu.style.top = Math.min(y, innerHeight - mh - 6) + 'px';
}
function hideMenu() { ctxmenu.classList.remove('show'); }

window.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(e.clientX, e.clientY); });
window.addEventListener('pointerdown', (e) => { if (!ctxmenu.contains(e.target)) hideMenu(); }, true);
window.addEventListener('blur', hideMenu);

ctxmenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.mi');
  if (!item) return;
  hideMenu();
  switch (item.dataset.act) {
    case 'open-file': await openFileDlg(); break;
    case 'open-dir': await openDirDlg(); break;
    case 'prev': stepBlock(-1); break;
    case 'next': stepBlock(+1); break;
    case 'toggle': togglePlay(); break;
    case 'faster': setSpeedDelta(+SPEED_STEP); break;
    case 'slower': setSpeedDelta(-SPEED_STEP); break;
    case 'stack':
      stackEnabled = !stackEnabled;
      showHint(stackEnabled ? '水平图上下堆叠：开' : '水平图上下堆叠：关');
      applyRelayout();
      break;
    case 'reveal': if (dir && n) ipcRenderer.invoke('show-in-folder', path.join(dir, files[currentImageIndex()])); break;
    case 'fullscreen': ipcRenderer.invoke('toggle-fullscreen'); break;
    case 'exit': window.close(); break;
  }
});

// 开关堆叠后重新分块，并保持当前观看的图片不跑掉
function applyRelayout() {
  if (!n) return;
  const anchorImg = currentImageIndex();
  rebuildLayout();
  const b = blockOfImage[anchorImg];
  offset = offsetToCenterBlock(b);
  normalizeOffset();
  lastHudKey = '';
  lastSyncKey = '';
  syncPool();
  moveTrack();
  updateHud();
}

async function openFileDlg() {
  const p = await ipcRenderer.invoke('open-file-dialog');
  if (p) openPath(p);
}
async function openDirDlg() {
  const p = await ipcRenderer.invoke('open-dir-dialog');
  if (p) openPath(p);
}

// ---------- 事件：拖放打开 ----------
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f && f.path) openPath(f.path);
});

// ---------- 事件：窗口尺寸变化（保持当前观看位置） ----------
window.addEventListener('resize', () => {
  const anchorImg = n ? currentImageIndex() : 0;
  vw = innerWidth || vw;
  H = innerHeight || H;
  if (!n) return;
  rebuildLayout();
  offset = offsetToCenterBlock(blockOfImage[anchorImg]);
  normalizeOffset();
  lastSyncKey = '';
  syncPool();
  moveTrack();
  updateHud();
});

// ---------- 启动 ----------
(async function init() {
  const p = await ipcRenderer.invoke('get-init-path');
  if (p) openPath(p);
  if (new URLSearchParams(location.search).has('smoke')) runSmoke();
})();

// ---------- 自动冒烟测试 ----------
function runSmoke() {
  const results = [];
  const check = (name, ok) => { results.push(`${ok ? 'PASS' : 'FAIL'} ${name}`); return ok; };

  setTimeout(() => {
    try {
      check('loaded-files', n === 10);
      check('all-sizes-known', sizes.size === 10);
      // 分块：10 张图里只有 b_04_orange + c_01_wide1 是连续两张水平图，应合成一块
      check('block-count', blocks.length === 9);
      check('stack-pair', blocks[7] && blocks[7].imgs.join() === '7,8');
      const pair = blocks[7];
      if (pair) {
        check('stack-geometry', pair.cells[0].y === 0 && pair.cells[1].y > 0 &&
          Math.abs(pair.cells[0].w / pair.cells[0].h - 900 / 600) < 0.01 &&
          Math.abs(pair.cells[1].w / pair.cells[1].h - 1600 / 600) < 0.01);
      } else check('stack-geometry', false);

      // 打开时定位到第 2 张（a_02_blue）
      check('focus-second-image', currentImageIndex() === 1);
      check('initial-speed', speed === 0 && playing === false);

      // 关键回归：后台测出尺寸后重新分块，画面不能漂移（这就是"快速闪过很多图片"的根因）
      seekToFraction(0.5);
      const beforeIdx = currentImageIndex();
      const beforeBlock = currentBlockIndex();
      sizes.set(files[0], { ratio: 3 }); // 人为改动第一张的比例，模拟异步测量结果到达
      xsDirty = true;
      advance(0.016);
      check('no-drift-on-relayout', currentImageIndex() === beforeIdx && currentBlockIndex() === beforeBlock);
      sizes.set(files[0], { ratio: 800 / 600 });
      xsDirty = true;
      advance(0.016);

      // 滚轮调速：第一次向下滚轮应该就是 0.2x，而不是叠在 1.0x 上变成 1.2x
      speed = 0; playing = false;
      setSpeedDelta(+SPEED_STEP);
      check('wheel-first-step-is-0.2x', playing === true && speed === SPEED_STEP);
      check('wheel-first-step-display', (speed / BASE_SPEED).toFixed(1) === '0.2');
      setSpeedDelta(+SPEED_STEP);
      check('wheel-second-step-is-0.4x', (speed / BASE_SPEED).toFixed(1) === '0.4');
      setSpeedDelta(-SPEED_STEP * 100);
      check('speed-clamp-low', speed === MIN_SPEED);
      speed = BASE_SPEED;

      // 空格暂停/继续
      playing = false; togglePlay();
      check('space-resume', playing === true);
      togglePlay();
      check('space-pause', playing === false);

      // 进度条拖到最后
      seekToFraction(1);
      check('seek-last', currentImageIndex() === n - 1);

      // 到末尾自动停下（没有循环）
      playing = true; speed = BASE_SPEED;
      offset = totalW * 3;
      advance(0.016);
      check('clamp-at-end', offset < totalW && playing === false);

      // 到开头自动停下
      playing = true; speed = -BASE_SPEED;
      offset = -totalW * 3;
      advance(0.016);
      check('clamp-at-start', offset > -totalW && playing === false);

      // 手动翻块
      playing = false; speed = BASE_SPEED;
      goToBlock(0, false);
      const b0 = currentBlockIndex();
      stepBlock(+1);
      anim = null;
      offset = offsetToCenterBlock(b0 + 1);
      normalizeOffset();
      check('next-block', currentBlockIndex() === b0 + 1);

      // 关掉堆叠后应变成 10 块
      stackEnabled = false;
      rebuildLayout();
      check('stack-off-blocks', blocks.length === 10);
      stackEnabled = true;
      rebuildLayout();
      check('stack-on-blocks', blocks.length === 9);

      // 动图能解码
      check('gif-in-list', files.some((f) => f.endsWith('.gif')));

      updateHud();
      check('hud-index', /^\d+(?:-\d+)? \/ 10$/.test(sbIndex.textContent));

      // 标题栏要带上图片名和进度
      goToBlock(0, false);
      lastHudKey = ''; updateHud();
      const title0 = document.title;
      check('title-has-name-and-progress', /^a_01_red\.png \(1\/10\) - SlideImageViewer$/.test(title0));
      // 自动播放推进后，标题栏要跟着更新
      playing = true; speed = BASE_SPEED;
      advance(3);
      updateHud();
      check('title-updates-while-playing', document.title !== title0 && /\(\d+(?:-\d+)?\/10\)/.test(document.title));
      playing = false; speed = BASE_SPEED;

      // 渲染池：只让视口内的图片参与绘制，视口外的隐藏但留在内存里
      goToBlock(0, false);
      lastSyncKey = ''; syncPool(); moveTrack();
      const imgs = [...track.querySelectorAll('img')];
      const shown = imgs.filter((el) => el.style.display !== 'none');
      check('pool-not-empty', imgs.length > 0);
      check('offscreen-not-painted', shown.length < imgs.length);
      check('painted-count-small', shown.length >= 1 && shown.length <= 6);
      check('track-transform-applied', /translate3d\(-?\d+px, 0px, 0px\)/.test(track.style.transform));

      // 走遍整条胶片，元素数量不能随图片数无限增长（否则内存和绘制都会失控）
      let maxPool = 0, maxShown = 0;
      for (let s = 0; s <= 40; s++) {
        offset = ((totalW - vw) * s) / 40;
        normalizeOffset();
        lastSyncKey = ''; syncPool();
        const all = [...track.querySelectorAll('img')];
        maxPool = Math.max(maxPool, all.length);
        maxShown = Math.max(maxShown, all.filter((el) => el.style.display !== 'none').length);
      }
      check('pool-stays-bounded', maxPool <= 10);
      check('painted-stays-bounded', maxShown <= 6);

      // 鼠标指针自动隐藏的状态逻辑
      playing = true; mouseInImage = true;
      showCursor(); syncCursor();
      check('cursor-hide-armed', cursorTimer !== 0);
      playing = false; syncCursor();
      check('cursor-visible-when-paused', cursorTimer === 0 && !strip.classList.contains('hide-cursor'));
      playing = true; mouseInImage = false; syncCursor();
      check('cursor-visible-outside-image', cursorTimer === 0 && !strip.classList.contains('hide-cursor'));
      cursorHidden = true; strip.classList.add('hide-cursor');
      showCursor();
      check('cursor-shown-clears-class', !strip.classList.contains('hide-cursor') && !cursorHidden);
      playing = false; mouseInImage = false;

      // 回归：打开几千张的文件夹时，不能把主线程堵住
      // （曾经因为一个循环写错，打开 5000 张的文件夹要卡 2.4 秒）
      const os = require('os');
      const tmpDir = path.join(os.tmpdir(), 'iv-smoke-many');
      fs.mkdirSync(tmpDir, { recursive: true });
      const BIG = 2000;
      if (fs.readdirSync(tmpDir).length < BIG) {
        const src = path.join(__dirname, 'test', 'images', 'a_01_red.png');
        const srcAbs = path.resolve('test', 'images', 'a_01_red.png');
        const use = fs.existsSync(src) ? src : srcAbs;
        for (let i = fs.readdirSync(tmpDir).length; i < BIG; i++) {
          const t = path.join(tmpDir, 'img_' + String(i).padStart(5, '0') + '.png');
          try { fs.linkSync(use, t); } catch { fs.copyFileSync(use, t); }
        }
      }
      const bigNames = fs.readdirSync(tmpDir).sort();
      const tOpen = performance.now();
      openPath(path.join(tmpDir, bigNames[0]));
      const msOpen = performance.now() - tOpen;
      check('open-many-not-blocking', msOpen < 150);
      check('open-many-lazy-sizes', n === BIG && sizes.size < 200);
      check('open-many-first-painted', track.querySelectorAll('img').length > 0);
    } catch (err) {
      results.push('FAIL exception ' + err.message);
    }
    for (const r of results) console.log('[SMOKE] ' + r);
    console.log('[SMOKE] ' + (results.every((r) => r.startsWith('PASS')) ? 'PASS ALL' : 'FAIL SOME'));
  }, 1500);
}
