'use strict';
// 性能测量：npx electron test/bench.js
// 在"1% 不透明度 + 不进任务栏 + 不抢焦点 + 不接受鼠标"的窗口里跑，用户看不到任何东西。
// 注意：这种窗口里 Chromium 会暂停图片动画，所以这里测的是主线程开销和 DOM 变动量，
// 不是真实的动画渲染帧率。
const { app } = require('electron');
const path = require('path');
const { createInvisibleWindow, loadApp } = require('./harness');

const initPath = path.join(__dirname, 'anim', 'anim_00.webp');
const DURATION = 4000;   // 测量时长（毫秒）
const WHEEL_STEPS = 10;  // 提速用的滚轮次数

app.whenReady().then(async () => {
  const win = createInvisibleWindow({ initPath });
  await loadApp(win);
  await new Promise((r) => setTimeout(r, 2000)); // 等图片和尺寸就绪

  // 单独测"每帧渲染代码"本身的耗时：滚轮推进 + 布局同步 + 平移 + 状态栏更新
  const perFrameMs = await win.webContents.executeJavaScript(`(() => {
    const span = Math.max(1, totalW - vw - 1);
    let o = 0;
    const N = 3000;
    maybeSyncPool(); moveTrack(); updateHud();      // 先跑一次热身
    const t0 = performance.now();
    for (let i = 0; i < N; i++) {
      offset = (o = (o + 34) % span);              // 每帧移动 34px，约等于 3.4 倍速
      maybeSyncPool();
      moveTrack();
      updateHud();
    }
    return +((performance.now() - t0) / N).toFixed(4);
  })()`);

  const res = await win.webContents.executeJavaScript(`(async () => {
    const strip = document.getElementById('strip');
    let added = 0, removed = 0;
    const mo = new MutationObserver((ms) => {
      for (const m of ms) { added += m.addedNodes.length; removed += m.removedNodes.length; }
    });
    mo.observe(strip, { childList: true, subtree: true });

    // 用滚轮事件起播并提速
    for (let i = 0; i < ${WHEEL_STEPS}; i++) {
      window.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, deltaMode: 0, cancelable: true }));
    }

    const frames = [];
    let last = performance.now();
    const t0 = last;
    // 滚动过程中每隔一会儿数一下"正在参与绘制"的图片数，取峰值
    let maxPainted = 0, samples = 0, sumPainted = 0, maxAt = null;
    const samplePainted = () => {
      let c = 0;
      for (const el of strip.querySelectorAll('img')) if (el.style.display !== 'none') c++;
      if (c > maxPainted) { maxPainted = c; maxAt = Math.round(offset); }
      sumPainted += c; samples++;
    };
    const sampler = setInterval(samplePainted, 100);
    await new Promise((res) => {
      const tick = (now) => {
        frames.push(now - last); last = now;
        if (now - t0 < ${DURATION}) requestAnimationFrame(tick); else res();
      };
      requestAnimationFrame(tick);
    });
    clearInterval(sampler);
    mo.disconnect();
    frames.shift(); // 丢掉第一帧（含启动开销）

    const sorted = [...frames].sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    const imgs = strip.querySelectorAll('img');
    let painted = 0;
    for (const el of imgs) if (el.style.display !== 'none') painted++;
    return {
      frames: frames.length,
      avgMs: +(frames.reduce((a, b) => a + b, 0) / frames.length).toFixed(2),
      p95Ms: +q(0.95).toFixed(2),
      maxMs: +sorted[sorted.length - 1].toFixed(2),
      longFrames: frames.filter((f) => f > 33).length,
      imgAdded: added,
      imgRemoved: removed,
      imgsInDom: imgs.length,
      imgsPainted: painted,
      maxPainted,
      avgPainted: +(sumPainted / Math.max(1, samples)).toFixed(1),
      maxAt, blocks: blocks.length, blockW: Math.round(blocks[0] ? blocks[0].w : 0), totalW: Math.round(totalW), vw, H,
      perFrameMs: ${perFrameMs},
    };
  })()`);

  // 对比：老逻辑渲染"视口左右各 1.5 屏"（共 4 屏）范围内的所有图片，
  // 新逻辑只绘制视口内的图片。两者都用真实布局统计，因此直接可比。
  const cmp = await win.webContents.executeJavaScript(`(() => {
    const bx = []; let acc = 0;
    for (const b of blocks) { bx.push(acc); acc += b.w; }
    const countIn = (from, to) => {
      let c = 0;
      for (let bi = 0; bi < blocks.length; bi++) {
        for (const cell of blocks[bi].cells) {
          const x = bx[bi] + cell.x;
          if (x < to && x + cell.w > from) c++;
        }
      }
      return c;
    };
    const span = Math.max(1, totalW - vw);
    let oldMax = 0, newMax = 0, oldSum = 0, newSum = 0, k = 0;
    for (let s = 0; s <= 60; s++) {
      const off = (span * s) / 60;
      const o = countIn(off - 1.5 * vw, off + 2.5 * vw);   // 老逻辑的渲染范围
      const n = countIn(off - 0.01 * vw, off + 1.01 * vw); // 新逻辑的渲染范围
      oldMax = Math.max(oldMax, o); newMax = Math.max(newMax, n);
      oldSum += o; newSum += n; k++;
    }
    return {
      totalImages: blocks.reduce((a, b) => a + b.cells.length, 0),
      oldAvg: +(oldSum / k).toFixed(1), oldMax,
      newAvg: +(newSum / k).toFixed(1), newMax,
      vw, H,
    };
  })()`);

  console.log('=== 性能测量结果 ===');
  console.log(`素材: ${cmp.totalImages} 张动画 WebP（800x600），窗口 ${cmp.vw}x${cmp.H}`);
  console.log(`测量时长 ${DURATION}ms，滚动速度约 3.4x`);
  console.log(`  帧数 ${res.frames}，平均帧间隔 ${res.avgMs}ms，p95 ${res.p95Ms}ms，最差 ${res.maxMs}ms`);
  console.log(`  超过 33ms 的卡顿帧: ${res.longFrames} 个`);
  console.log(`  期间创建/移除的图片元素: ${res.imgAdded} / ${res.imgRemoved} 个`);
  console.log('');
  console.log('  【关键】同时参与绘制的图片数（这些动图会一起解码播放）:');
  console.log(`    优化前（渲染视口左右各 1.5 屏）: 平均 ${cmp.oldAvg} 张，峰值 ${cmp.oldMax} 张`);
  console.log(`    优化后（只绘制视口内的图片）:   平均 ${cmp.newAvg} 张，峰值 ${cmp.newMax} 张`);
  console.log(`    实测滚动过程中: 平均 ${res.avgPainted} 张，峰值 ${res.maxPainted} 张`);
  console.log('');
  console.log(`  每帧渲染代码耗时: ${res.perFrameMs}ms（占 16.7ms 帧预算的 ${(res.perFrameMs / 16.7 * 100).toFixed(2)}%）`);
  app.exit(0);
});
