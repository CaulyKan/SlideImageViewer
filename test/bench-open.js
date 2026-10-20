'use strict';
// 测量"打开大文件夹 → 第一张图出现"的耗时，并拆出各阶段占比。
// 用法：npx electron test/bench-open.js [文件数量]
// 测试素材用硬链接生成（不占额外磁盘空间），放在系统临时目录，不污染项目。
const { app } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createInvisibleWindow, loadApp } = require('./harness');

const COUNT = Number(process.argv[2]) || 5000;
const DIR = path.join(os.tmpdir(), 'iv-many-' + COUNT);
const SRC = path.join(__dirname, 'images');

// ---------- 造素材 ----------
function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
  const names = fs.readdirSync(DIR).filter((f) => /\.(png|gif)$/i.test(f));
  if (names.length === COUNT) return names.length;
  const srcs = fs.readdirSync(SRC).filter((f) => /\.(png|gif)$/i.test(f)).map((f) => path.join(SRC, f));
  for (let i = names.length; i < COUNT; i++) {
    const target = path.join(DIR, 'photo_' + String(i).padStart(6, '0') + path.extname(srcs[i % srcs.length]));
    try {
      fs.linkSync(srcs[i % srcs.length], target);   // 硬链接，瞬间完成且不占空间
    } catch {
      fs.copyFileSync(srcs[i % srcs.length], target);
    }
  }
  return fs.readdirSync(DIR).length;
}

app.whenReady().then(async () => {
  const t0 = Date.now();
  const made = ensureDir();
  console.log(`测试素材: ${DIR}`);
  console.log(`  共 ${made} 个图片文件（生成/检查耗时 ${Date.now() - t0}ms）`);

  const win = createInvisibleWindow();
  await loadApp(win);
  await new Promise((r) => setTimeout(r, 800));

  const r = await win.webContents.executeJavaScript(`(async () => {
    const dir = ${JSON.stringify(DIR)};
    const fs = require('fs');
    const path = require('path');
    const IMG = new Set(['jpg','jpeg','jfif','png','gif','webp','bmp','avif','svg','ico']);
    const t = () => performance.now();

    // ---- 阶段 1：列举文件（当前写法：逐个 stat 判断是不是文件）----
    let a = t();
    const curList = fs.readdirSync(dir).filter((f) => {
      try { return fs.statSync(path.join(dir, f)).isFile() && IMG.has(path.extname(f).slice(1).toLowerCase()); }
      catch { return false; }
    });
    const msStatList = t() - a;

    // ---- 阶段 1b：改用 readdir 自带的类型信息（不需要额外 stat）----
    a = t();
    const newList = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => (e.isFile() || e.isSymbolicLink()) && IMG.has(path.extname(e.name).slice(1).toLowerCase()))
      .map((e) => e.name);
    const msDirentList = t() - a;

    // ---- 阶段 2：排序（当前写法：localeCompare 带选项）----
    a = t();
    const s1 = curList.slice().sort((x, y) => x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' }));
    const msSortLocale = t() - a;

    // ---- 阶段 2b：复用同一个 Collator 实例 ----
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    a = t();
    const s2 = curList.slice().sort((x, y) => coll.compare(x, y));
    const msSortCollator = t() - a;

    // 两种排序结果必须一致，否则不能换
    let same = s1.length === s2.length;
    for (let i = 0; same && i < s1.length; i++) if (s1[i] !== s2[i]) same = false;

    // ---- 阶段 3：同步读取尺寸（现在只读起点附近的一小段）----
    a = t();
    scanSizes(curList, dir, 0);
    const msScanSizes = t() - a;
    const scannedCount = sizes.size;

    // ---- 阶段 4：整条打开流程（真实调用 openPath）----
    a = t();
    openPath(path.join(dir, curList[0]));
    const msOpenPath = t() - a;

    // ---- 阶段 5：第一张图真正可用（图片数据加载完成）----
    a = t();
    const first = track.querySelector('img');
    let msFirstImg = -1;
    if (first) {
      if (first.complete && first.naturalWidth > 0) msFirstImg = t() - a;
      else {
        await new Promise((res) => {
          first.addEventListener('load', res, { once: true });
          first.addEventListener('error', res, { once: true });
          setTimeout(res, 5000);
        });
        msFirstImg = t() - a;
      }
    }
    // ---- 阶段 6：后台补齐全部尺寸需要多久 ----
    a = t();
    const total = curList.length;
    while (sizes.size < total && t() - a < 20000) {
      await new Promise((res) => setTimeout(res, 50));
    }
    const msAllSizes = t() - a;
    return {
      count: curList.length,
      msStatList: +msStatList.toFixed(1),
      msDirentList: +msDirentList.toFixed(1),
      msSortLocale: +msSortLocale.toFixed(1),
      msSortCollator: +msSortCollator.toFixed(1),
      sortSame: same,
      msScanSizes: +msScanSizes.toFixed(1),
      scannedCount,
      msOpenPath: +msOpenPath.toFixed(1),
      msFirstImg: +msFirstImg.toFixed(1),
      msAllSizes: +msAllSizes.toFixed(1),
      sizesDone: sizes.size,
      imgsInDom: track.querySelectorAll('img').length,
    };
  })()`);

  console.log('');
  console.log('=== 打开文件夹各阶段耗时 ===');
  console.log(`  列举文件（当前写法：逐个 stat）: ${r.msStatList}ms`);
  console.log(`  列举文件（改用 readdir 类型信息）: ${r.msDirentList}ms   ← 快 ${(r.msStatList / Math.max(0.1, r.msDirentList)).toFixed(1)} 倍`);
  console.log(`  排序（localeCompare 带选项）: ${r.msSortLocale}ms`);
  console.log(`  排序（复用 Collator 实例）: ${r.msSortCollator}ms   ← 快 ${(r.msSortLocale / Math.max(0.1, r.msSortCollator)).toFixed(1)} 倍，结果一致=${r.sortSame}`);
  console.log(`  同步读取尺寸: ${r.msScanSizes}ms（本次只读了 ${r.scannedCount} 张）`);
  console.log('');
  console.log(`  【关键】openPath 全程阻塞: ${r.msOpenPath}ms`);
  console.log(`  【关键】第一张图数据就绪: ${r.msFirstImg}ms`);
  console.log(`  后台补齐全部 ${r.count} 张尺寸: 约 ${r.msAllSizes}ms（不阻塞操作，已补 ${r.sizesDone} 张）`);
  console.log(`  DOM 内图片元素: ${r.imgsInDom} 个`);
  app.exit(0);
}).catch((err) => {
  console.error('测量失败:', err);
  app.exit(1);
});
