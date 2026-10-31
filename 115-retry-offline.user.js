// ==UserScript==
// @name         115 云下载失败任务一键重试
// @namespace    115.retry-offline
// @version      1.1.1
// @description  115网盘 云下载（离线下载）失败任务：一键全部重试 / 单个重试。自动删除旧失败记录，按原链接 + 原保存目录重新添加
// @author       local
// @match        https://115.com/*
// @run-at       document-idle
// @noframes
// @license      MIT
// ==/UserScript==

(function () {
  "use strict";
  if (window.__115RetryOfflineLoaded) return;
  window.__115RetryOfflineLoaded = true;

  /* ================= 可调参数（按需修改） ================= */
  const CONFIG = {
    delayMs: 800, // 每个任务操作之间的间隔（毫秒），防止触发 115 限流
    requestTimeoutMs: 30000, // 单个请求超时（毫秒），面板里可按秒调整
    maxPages: 100, // 拉取任务列表的最大页数（防止死循环）
    scanSeconds: 20, // 单次扫描时间预算（秒），到点后提供「继续扫描」
    deleteOld: true, // 重新添加前是否先删除旧的失败记录
    failedStatus: -1, // 115 任务状态：-1 失败 / 1 进行中 / 2 完成
  };

  // 115 网页版离线（云下载）接口，参考社区项目（elevengo / JavPack）
  const API = {
    list: (p) => `https://115.com/web/lixian/?ct=lixian&ac=task_lists&page=${p}`,
    add: "https://115.com/web/lixian/?ct=lixian&ac=add_task_url",
    del: "https://115.com/web/lixian/?ct=lixian&ac=task_del",
  };
  /* ========================================================= */

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const store = {
    get(k, d) {
      try {
        const v = localStorage.getItem("115retry." + k);
        return v === null ? d : JSON.parse(v);
      } catch (e) {
        return d;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("115retry." + k, JSON.stringify(v));
      } catch (e) {
        /* ignore */
      }
    },
  };

  // 允许用户在面板里调整间隔/超时，优先读本地存储
  CONFIG.delayMs = Number(store.get("delayMs", CONFIG.delayMs)) || CONFIG.delayMs;
  CONFIG.requestTimeoutMs = Number(store.get("requestTimeoutMs", CONFIG.requestTimeoutMs)) || CONFIG.requestTimeoutMs;

  /* ---------- API 封装 ---------- */
  async function apiGet(url) {
    const timeoutMs = CONFIG.requestTimeoutMs;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { credentials: "include", signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      throw new Error(e.name === "AbortError" ? "请求超时" : "网络错误: " + e.message);
    }
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new Error("接口返回非 JSON（可能未登录或接口已变化）: " + text.slice(0, 120).replace(/\s+/g, " "));
    }
  }

  async function apiPost(url, fields) {
    const timeoutMs = CONFIG.requestTimeoutMs;
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v === "" || v == null) continue;
      fd.append(k, String(v));
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(url, { method: "POST", body: fd, credentials: "include", signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      throw new Error(e.name === "AbortError" ? "请求超时" : "网络错误: " + e.message);
    }
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    let j;
    try {
      j = JSON.parse(text);
    } catch (e) {
      throw new Error("接口返回非 JSON: " + text.slice(0, 120).replace(/\s+/g, " "));
    }
    return j;
  }

  function errMsg(j) {
    return (j && (j.error_msg || j.err_msg)) || (j && j.errcode ? `errcode=${j.errcode}` : "未知错误");
  }

  /* ---------- 扫描失败任务（可续扫、有重复页检测） ---------- */
  const scan = { page: 1, done: false, useStatusFilter: false, seen: new Set(), tasks: [], lastFps: [] };

  function resetScan() {
    Object.assign(scan, { page: 1, done: false, useStatusFilter: false, seen: new Set(), tasks: [], lastFps: [] });
  }

  const TOTAL_KEYS = ["task_count", "count", "total", "task_num", "total_count", "taskCount"];
  function findTotal(j) {
    for (const k of TOTAL_KEYS) {
      const v = j && j[k];
      if (typeof v === "number" && v > 0) return v;
      if (typeof v === "string" && /^\d+$/.test(v)) return Number(v);
    }
    return 0;
  }

  const taskKey = (t) => String(t.info_hash || "") + "|" + String(t.url || "");

  async function fetchPage(page) {
    const url = API.list(page) + (scan.useStatusFilter ? "&status=-1" : "");
    return apiGet(url);
  }

  /**
   * 扫描到时间预算结束或列表读完整。
   * @param {(text:string, isError:boolean)=>void} onProgress
   */
  async function scanOnce(onProgress) {
    const deadline = Date.now() + CONFIG.scanSeconds * 1000;
    let guard = 0;
    while (!scan.done && guard++ < 500 && Date.now() < deadline) {
      let j;
      try {
        j = await fetchPage(scan.page);
      } catch (e) {
        scan.done = true;
        onProgress(`第 ${scan.page} 页请求失败：${e.message}`, true);
        break;
      }
      if (scan.page === 1) {
        console.log("[115-retry] task_lists 第 1 页响应:", j);
        const rawTasks0 = Array.isArray(j && j.tasks) ? j.tasks : [];
        // 若第 1 页全是失败任务，尝试启用服务端 status 过滤（猜测错误也无害，重复页检测兜底）
        if (rawTasks0.length) scan.useStatusFilter = rawTasks0.every((t) => Number(t.status) === CONFIG.failedStatus);
      }
      const rawTasks = Array.isArray(j && j.tasks) ? j.tasks : [];

      // 与已扫过的页面数据完全相同 → 接口不支持翻页或已到末页
      const fp = rawTasks.map(taskKey).join(",");
      if (scan.lastFps.includes(fp)) {
        scan.done = true;
        onProgress("扫描完成（后续页无新数据）", false);
        break;
      }
      scan.lastFps.push(fp);

      for (const t of rawTasks) {
        const k = taskKey(t);
        if (scan.seen.has(k)) continue;
        scan.seen.add(k);
        if (Number(t.status) === CONFIG.failedStatus) scan.tasks.push(t);
      }

      const total = findTotal(j);
      if (!rawTasks.length) {
        scan.done = true;
        onProgress("扫描完成", false);
        break;
      }
      if (total > 0 && scan.page * rawTasks.length >= total) {
        scan.done = true;
        onProgress("扫描完成", false);
        break;
      }
      if (scan.page >= CONFIG.maxPages) {
        scan.done = true;
        onProgress(`已达最大页数 ${CONFIG.maxPages}，停止扫描`, false);
        break;
      }
      scan.page += 1;
      onProgress(`已扫 ${scan.page - 1} 页，发现 ${scan.tasks.length} 个失败任务…`, false);
      await sleep(250);
    }
  }

  /* ---------- 重试逻辑 ---------- */
  /**
   * 重试单个任务：删除旧失败记录 -> 按原链接+原目录重新添加
   * @returns {Promise<string>} 结果说明；"EXISTS" 表示任务已存在无需处理
   */
  async function retryOne(task) {
    if (CONFIG.deleteOld && task.info_hash) {
      try {
        const d = await apiPost(API.del, { "hash[0]": task.info_hash });
        if (d && d.state === false) console.warn("[115-retry] 删除旧任务返回:", d, "（继续重新添加）");
      } catch (e) {
        console.warn("[115-retry] 删除旧任务异常:", e.message, "（继续重新添加）");
      }
    }
    if (!task.url) throw new Error("任务缺少链接，无法自动重新添加（可手动复制磁链后在 115 里添加）");
    await sleep(CONFIG.delayMs);
    const a = await apiPost(API.add, { url: task.url, wp_path_id: task.wp_path_id || "" });
    if (a && a.state === true) return "已重新添加";
    if (Number(a && a.errcode) === 10008) return "EXISTS"; // 同 hash 任务已存在（例如正在下载中）
    throw new Error(errMsg(a));
  }

  /* ---------- UI ---------- */
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  const host = document.createElement("div");
  host.style.cssText = "all:initial; position:fixed; right:20px; bottom:20px; z-index:2147483647;";
  const shadow = host.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    .wrap { position: fixed; right: 0; bottom: 0; }
    .fab {
      all: unset; cursor: pointer; user-select: none;
      position: fixed; right: 20px; bottom: 20px;
      display: inline-flex; align-items: center; gap: 6px;
      padding: 10px 16px; border-radius: 999px;
      background: #1664ff; color: #fff; font-size: 14px; font-weight: 600;
      box-shadow: 0 4px 16px rgba(22,100,255,.4);
    }
    .fab:hover { background: #0e52e0; }
    .panel {
      position: fixed; right: 20px; bottom: 74px;
      width: 600px; max-width: calc(100vw - 40px);
      max-height: 72vh; display: flex; flex-direction: column;
      background: #fff; color: #1a1a1a; border-radius: 12px;
      box-shadow: 0 8px 32px rgba(0,0,0,.22); overflow: hidden;
      font-size: 13px;
    }
    .head {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 12px 14px; background: #f5f7fa; border-bottom: 1px solid #e6e9ef;
    }
    .head b { font-size: 14px; flex: 1; min-width: 120px; }
    .btn {
      all: unset; cursor: pointer; border-radius: 6px;
      padding: 5px 12px; font-size: 13px; line-height: 1.4;
      background: #1664ff; color: #fff;
    }
    .btn:hover { background: #0e52e0; }
    .btn:disabled { background: #9db8e8; cursor: default; }
    .btn.plain { background: #eef1f5; color: #333; }
    .btn.plain:hover { background: #e2e7ee; }
    .btn.danger { background: #e5484d; }
    .btn.danger:hover { background: #d13438; }
    .busy {
      padding: 10px 14px; color: #555; font-size: 12px;
      border-bottom: 1px solid #f0f2f5; background: #fafbfc;
      display: none;
    }
    .busy.show { display: block; }
    .busy.err { color: #e5484d; background: #fff5f5; }
    .progress {
      padding: 8px 14px; background: #fff8e6; color: #8a6d00;
      display: none; align-items: center; gap: 10px; font-size: 12px;
      border-bottom: 1px solid #f2e8c8;
    }
    .progress.show { display: flex; }
    .list { overflow: auto; }
    .row {
      display: flex; align-items: center; gap: 10px;
      padding: 10px 14px; border-bottom: 1px solid #f0f2f5;
    }
    .row:hover { background: #fafbfc; }
    .dot { width: 9px; height: 9px; border-radius: 50%; background: #c3c9d2; flex: none; }
    .dot.run { background: #1664ff; animation: pulse 1s infinite; }
    .dot.ok { background: #2f9e44; }
    .dot.fail { background: #e5484d; }
    .dot.skip { background: #f0a202; }
    @keyframes pulse { 50% { opacity: .35; } }
    .info { flex: 1; min-width: 0; }
    .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .url { color: #667; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px; }
    .meta { color: #99a; font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .msg { color: #e5484d; font-size: 12px; margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .msg.ok { color: #2f9e44; }
    .msg.skip { color: #b07d00; }
    .row .btn { flex: none; }
    .row .btn.mini { padding: 3px 10px; font-size: 12px; }
    .foot {
      padding: 10px 14px; border-top: 1px solid #e6e9ef; background: #fafbfc;
      color: #667; font-size: 12px; line-height: 1.7;
    }
    .foot input {
      width: 70px; padding: 2px 6px; border: 1px solid #ccd; border-radius: 4px; font-size: 12px;
    }
  `;
  shadow.append(style);

  const wrap = el("div", "wrap");
  const panel = el("div", "panel");
  panel.style.display = "none";

  const head = el("div", "head");
  const headTitle = el("b", null, "云下载失败任务");
  const btnAll = el("button", "btn", "全部重试");
  const btnStop = el("button", "btn danger", "停止");
  const btnMore = el("button", "btn plain", "继续扫描");
  const btnRefresh = el("button", "btn plain", "刷新");
  const btnCopyAll = el("button", "btn plain", "复制全部链接");
  const btnClose = el("button", "btn plain", "×");
  btnStop.style.display = "none";
  btnMore.style.display = "none";
  head.append(headTitle, btnAll, btnStop, btnMore, btnRefresh, btnCopyAll, btnClose);

  const busyLine = el("div", "busy");
  const progress = el("div", "progress");
  const progressText = el("span", null, "");
  progress.append(progressText);

  const list = el("div", "list");

  const foot = el("div", "foot");
  const delayInput = el("input");
  delayInput.value = String(CONFIG.delayMs);
  delayInput.addEventListener("change", () => {
    const v = Number(delayInput.value);
    if (v >= 0) {
      CONFIG.delayMs = v;
      store.set("delayMs", v);
    }
  });
  foot.append(document.createTextNode("操作间隔(ms): "), delayInput);
  const timeoutInput = el("input");
  timeoutInput.value = String(Math.round(CONFIG.requestTimeoutMs / 1000));
  timeoutInput.addEventListener("change", () => {
    const v = Number(timeoutInput.value);
    if (v > 0) {
      CONFIG.requestTimeoutMs = Math.round(v * 1000);
      store.set("requestTimeoutMs", CONFIG.requestTimeoutMs);
    }
  });
  foot.append(document.createTextNode("  请求超时(秒): "), timeoutInput);
  foot.append(el("div", null, "重试 = 删除旧失败记录 + 按原链接/原目录重新添加；完成后请刷新 115 页面查看新任务。"));

  panel.append(head, busyLine, progress, list, foot);

  const fab = el("button", "fab", "↻ 重试失败任务");
  wrap.append(panel, fab);
  shadow.append(wrap);
  document.body.append(host);

  /* ---------- 状态 ---------- */
  let tasks = [];
  let running = false; // 全部重试进行中
  let scanning = false; // 扫描进行中
  let stopFlag = false;
  const rowMap = new Map(); // info_hash -> row DOM

  function setStatusLine(text, isError) {
    busyLine.textContent = text;
    busyLine.className = "busy" + (text ? " show" : "") + (isError ? " err" : "");
  }

  function setRow(row, state, msg) {
    row.querySelector(".dot").className = "dot " + state;
    const m = row.querySelector(".msg");
    if (m) m.remove();
    if (msg) {
      const div = el("div", "msg " + (state === "ok" ? "ok" : state === "skip" ? "skip" : ""), msg);
      row.querySelector(".info").append(div);
    }
  }

  function fmtTime(ts) {
    if (!ts) return "";
    const d = new Date(ts * 1000);
    if (isNaN(d.getTime())) return "";
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  function renderRows() {
    list.textContent = "";
    rowMap.clear();
    if (!tasks.length) {
      const none = el("div", null, scan.done ? "没有发现失败任务 🎉" : `尚未发现失败任务（扫描未完成，可点「继续扫描」）`);
      none.style.cssText = "padding:20px;text-align:center;color:" + (scan.done ? "#2f9e44" : "#889") + ";font-size:14px;";
      list.append(none);
      return;
    }
    for (const t of tasks) {
      const row = el("div", "row");
      const info = el("div", "info");
      const name = el("div", "name", t.name || t.url || t.info_hash || "(未命名)");
      name.title = t.name || "";
      const url = el("div", "url", t.url || "（无链接）");
      url.title = t.url || "";
      const meta = el("div", "meta", `失败任务 · 保存目录 cid: ${t.wp_path_id || "默认"} · 添加于 ${fmtTime(t.add_time) || "?"}`);
      info.append(name, url, meta);

      const btn = el("button", "btn mini", t.url ? "重试" : "无法重试");
      if (!t.url) {
        btn.disabled = true;
        btn.title = "该任务缺少链接，无法自动重新添加";
      }
      const copy = el("button", "btn plain mini", "⧉");
      copy.title = "复制链接";

      row.append(el("span", "dot"), info, copy, btn);
      list.append(row);
      rowMap.set(taskKey(t), row);

      btn.addEventListener("click", async () => {
        if (running || scanning) return;
        setRow(row, "run");
        btn.disabled = true;
        try {
          const res = await retryOne(t);
          setRow(row, res === "EXISTS" ? "skip" : "ok", res === "EXISTS" ? "任务已存在，无需重试" : "已重新添加，刷新页面查看");
        } catch (e) {
          setRow(row, "fail", e.message);
        }
        btn.disabled = false;
      });
      copy.addEventListener("click", async () => {
        if (!t.url) return;
        try {
          await navigator.clipboard.writeText(t.url);
          copy.textContent = "✓";
        } catch (e) {
          copy.textContent = "✗";
        }
        setTimeout(() => (copy.textContent = "⧉"), 1200);
      });
    }
  }

  function updateHead() {
    headTitle.textContent = `云下载失败任务（${tasks.length}）` + (scan.done ? "" : " · 扫描未完成");
    btnMore.style.display = !scan.done ? "" : "none";
  }

  async function load() {
    resetScan();
    tasks = [];
    renderRows();
    updateHead();
    scanning = true;
    setStatusLine("正在加载失败任务列表…");
    await scanOnce((text, isError) => setStatusLine(text, isError));
    scanning = false;
    tasks = scan.tasks.slice().sort((a, b) => (b.add_time || 0) - (a.add_time || 0));
    renderRows();
    updateHead();
    if (!busyLine.classList.contains("err")) setStatusLine("");
  }

  async function loadMore() {
    if (scan.done || scanning || running) return;
    scanning = true;
    btnMore.disabled = true;
    setStatusLine(`从第 ${scan.page} 页继续扫描…`);
    await scanOnce((text, isError) => setStatusLine(text, isError));
    scanning = false;
    btnMore.disabled = false;
    tasks = scan.tasks.slice().sort((a, b) => (b.add_time || 0) - (a.add_time || 0));
    renderRows();
    updateHead();
    if (scan.done) setStatusLine("");
  }

  async function retryAll() {
    if (!tasks.length || running || scanning) return;
    running = true;
    stopFlag = false;
    btnAll.disabled = true;
    btnStop.style.display = "";
    progress.classList.add("show");
    let ok = 0, fail = 0, skip = 0;

    for (const t of tasks) {
      if (stopFlag) break;
      const row = rowMap.get(taskKey(t));
      if (!row || !t.url) {
        if (row) setRow(row, "skip", "缺少链接，跳过");
        skip++;
      } else {
        setRow(row, "run");
        try {
          const res = await retryOne(t);
          if (res === "EXISTS") {
            setRow(row, "skip", "任务已存在，无需重试");
            skip++;
          } else {
            setRow(row, "ok", "已重新添加");
            ok++;
          }
        } catch (e) {
          setRow(row, "fail", e.message);
          fail++;
        }
      }
      progressText.textContent = `进行中：成功 ${ok} · 失败 ${fail} · 跳过 ${skip} / 共 ${tasks.length}` + (!scan.done ? "（列表扫描未完成，可先「继续扫描」）" : "");
      progressText.style.color = fail ? "#c23616" : "#8a6d00";
      if (!stopFlag && t !== tasks[tasks.length - 1]) await sleep(CONFIG.delayMs);
    }

    progressText.textContent = stopFlag
      ? `已停止。成功 ${ok} · 失败 ${fail} · 跳过 ${skip}`
      : `完成：成功 ${ok} · 失败 ${fail} · 跳过 ${skip}。请刷新 115 页面查看新任务。`;
    progressText.style.color = fail ? "#c23616" : "#2f9e44";
    running = false;
    stopFlag = false;
    btnAll.disabled = false;
    btnStop.style.display = "none";
  }

  fab.addEventListener("click", () => {
    if (panel.style.display !== "none") {
      panel.style.display = "none";
      fab.textContent = "↻ 重试失败任务";
    } else {
      panel.style.display = "";
      fab.textContent = "× 关闭";
      if (!tasks.length && !scanning && !running) load();
    }
  });
  btnClose.addEventListener("click", () => {
    panel.style.display = "none";
    fab.textContent = "↻ 重试失败任务";
  });
  btnRefresh.addEventListener("click", load);
  btnAll.addEventListener("click", retryAll);
  btnStop.addEventListener("click", () => (stopFlag = true));
  btnMore.addEventListener("click", loadMore);
  btnCopyAll.addEventListener("click", async () => {
    const urls = tasks.map((t) => t.url).filter(Boolean);
    if (!urls.length) return;
    try {
      await navigator.clipboard.writeText(urls.join("\n"));
      btnCopyAll.textContent = "✓ 已复制";
    } catch (e) {
      btnCopyAll.textContent = "✗ 复制失败";
    }
    setTimeout(() => (btnCopyAll.textContent = "复制全部链接"), 1500);
  });

  console.log("[115-retry] 已注入，点击右下角「↻ 重试失败任务」");
})();
