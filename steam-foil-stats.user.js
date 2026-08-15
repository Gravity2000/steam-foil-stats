// ==UserScript==
// @name         Steam 补充包闪卡统计
// @namespace    https://github.com/Gravity2000
// @version      1.1.0
// @updateURL    https://raw.githubusercontent.com/Gravity2000/steam-foil-stats/main/steam-foil-stats.user.js
// @downloadURL  https://raw.githubusercontent.com/Gravity2000/steam-foil-stats/main/steam-foil-stats.user.js
// @supportURL   https://github.com/Gravity2000/steam-foil-stats/issues
// @description  扫描 Steam 库存历史，统计补充包开出闪卡的实际概率（单卡出闪率 + 单包含闪率）
// @author       Gravity2000
// @match        https://steamcommunity.com/id/*/inventoryhistory*
// @match        https://steamcommunity.com/profiles/*/inventoryhistory*
// @match        https://steamcommunity.com/my/inventoryhistory*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const STORE_KEY = "foilstats_events_v1";
  const LIMIT_KEY = "foilstats_limit_v1";
  const EVENT_KEYWORDS = ["已拆开补充包", "Unpacked booster pack", "拆開補充包"];
  const FOIL_MARKERS = ["(闪亮)", "（闪亮）", "(閃亮)", "(Foil)"];
  const PAGE_DELAY_MS = 4000;
  const MAX_PAGES = 400;

  let scanning = false;
  let abort = false;

  // ---------------- 存储（油猴同步 API） ----------------
  const loadEvents = () => {
    try { return JSON.parse(GM_getValue(STORE_KEY, "{}")); } catch { return {}; }
  };
  const saveEvents = m => GM_setValue(STORE_KEY, JSON.stringify(m));
  const loadLimit = () => {
    const v = parseInt(GM_getValue(LIMIT_KEY, 0), 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const saveLimit = v => GM_setValue(LIMIT_KEY, v);

  // ---------------- 工具 ----------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isFoilName = n => FOIL_MARKERS.some(m => n.includes(m));
  const isBoosterEvent = d => EVENT_KEYWORDS.some(k => d.includes(k));

  function wilson(successes, total, z = 1.96) {
    if (total === 0) return [0, 0];
    const p = successes / total;
    const d = 1 + z * z / total;
    const c = p + z * z / (2 * total);
    const s = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total));
    return [Math.max(0, (c - s) / d), Math.min(1, (c + s) / d)];
  }

  function parseTime(text) {
    if (!text) return 0;
    let y, mo, d;
    const zh = text.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (zh) {
      [, y, mo, d] = zh.map(Number);
    } else {
      const en = text.match(/(\d{1,2})\s+([A-Za-z]{3})[a-z]*,?\s*(\d{4})/)
             || text.match(/([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s*(\d{4})/);
      if (!en) return 0;
      const MON = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6,
                    jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
      if (/^\d/.test(en[1])) { d = +en[1]; mo = MON[en[2].toLowerCase()]; y = +en[3]; }
      else { mo = MON[en[1].toLowerCase()]; d = +en[2]; y = +en[3]; }
      if (!mo) return 0;
    }
    let h = 0, mi = 0;
    const t = text.match(/(\d{1,2}):(\d{2})/);
    if (t) {
      h = +t[1]; mi = +t[2];
      if (/下午|PM|pm/.test(text) && h < 12) h += 12;
      if (/上午|AM|am/.test(text) && h === 12) h = 0;
    }
    const ms = new Date(y, mo - 1, d, h, mi).getTime();
    return isNaN(ms) ? 0 : ms;
  }

  function recentEvents(map, limit) {
    const all = Object.values(map).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return limit > 0 ? all.slice(0, limit) : all;
  }

  // ---------------- 解析 ----------------
  function parseRow(row) {
    const desc = row.querySelector(".tradehistory_event_description");
    if (!desc || !isBoosterEvent(desc.textContent.trim())) return null;

    const groups = row.querySelectorAll(".tradehistory_items");
    if (groups.length < 2) return null;

    let boosterName = "";
    let received = [];

    groups.forEach(g => {
      const sign = g.querySelector(".tradehistory_items_plusminus");
      if (!sign) return;
      const names = [...g.querySelectorAll(".history_item_name")].map(n => n.textContent.trim());
      const s = sign.textContent.trim();
      if (s === "-" && names.length) boosterName = names[0];
      else if (s === "+") received = received.concat(names);
    });

    if (!received.length) return null;

    const anyItem = row.querySelector("[id^='history']");
    const id = anyItem
      ? anyItem.id.replace(/^history/, "").replace(/_item\d+$/, "")
      : `${boosterName}|${received.join(",")}|${Math.random()}`;

    const dateEl = row.querySelector(".tradehistory_date");
    const time = dateEl ? dateEl.textContent.replace(/\s+/g, " ").trim() : "";

    return {
      id, time, ts: parseTime(time),
      game: boosterName.replace(/\s*补充包\s*$/, "").replace(/\s*Booster Pack\s*$/i, "").trim(),
      cards: received,
      foils: received.filter(isFoilName)
    };
  }

  const parseHtml = html =>
    [...new DOMParser().parseFromString(html, "text/html")
      .querySelectorAll(".tradehistoryrow")].map(parseRow).filter(Boolean);

  // ---------------- 抓取 ----------------
  function readInitialCursor() {
    const m = document.documentElement.innerHTML.match(/g_historyCursor\s*=\s*(\{[\s\S]*?\});/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch { return null; }
  }

  function buildUrl(cursor, filterApp) {
    const base = location.pathname.replace(/\/?$/, "/");
    const p = new URLSearchParams();
    p.set("ajax", "1");
    if (filterApp) p.append("app[]", "753");
    if (cursor) {
      p.set("cursor[time]", cursor.time);
      p.set("cursor[time_frac]", cursor.time_frac);
      p.set("cursor[s]", cursor.s);
    }
    return `${base}?${p.toString()}`;
  }

  async function fetchPage(cursor, filterApp) {
    const res = await fetch(buildUrl(cursor, filterApp), {
      credentials: "include",
      headers: { "X-Requested-With": "XMLHttpRequest" }
    });
    if (res.status === 429) throw new Error("RATE_LIMIT");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ---------------- 样式 ----------------
  const css = `
  #fs-embed {
    background: #16202d;
    border: 1px solid #2f4257;
    border-radius: 3px;
    margin: 0 0 16px 0;
    color: #c7d5e0;
    font: 13px/1.5 "Motiva Sans", Arial, sans-serif;
  }
  #fs-embed .fs-head {
    background: linear-gradient(to right, #2a475e, #1b2838);
    padding: 8px 14px;
    font-size: 14px;
    color: #fff;
    display: flex; justify-content: space-between; align-items: center;
    border-bottom: 1px solid #2f4257;
  }
  #fs-embed .fs-head .fs-toggle { cursor: pointer; font-size: 12px; color: #8f98a0; }
  #fs-embed .fs-head .fs-toggle:hover { color: #66c0f4; }
  #fs-embed.fs-collapsed .fs-inner { display: none; }
  #fs-embed .fs-inner { padding: 14px; }
  #fs-embed .fs-ctrl { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 12px; }
  #fs-embed button {
    background: linear-gradient(to bottom, #4c6b91, #395778);
    border: none; color: #fff; padding: 6px 12px;
    border-radius: 2px; cursor: pointer; font-size: 12px;
  }
  #fs-embed button:hover { background: linear-gradient(to bottom, #5a7fa8, #47688c); }
  #fs-embed button:disabled { background: #2a3a4a; color: #6a7a8a; cursor: default; }
  #fs-embed button.fs-danger { background: linear-gradient(to bottom, #8a4444, #6a3232); }
  #fs-embed input[type=number] {
    width: 76px; background: #0e1621; border: 1px solid #2f4257;
    color: #c7d5e0; padding: 5px 7px; border-radius: 2px; font-size: 12px;
  }
  #fs-embed .fs-sep { color: #4a5a6a; }
  #fs-embed .fs-grid { display: flex; flex-wrap: wrap; gap: 14px; }
  #fs-embed .fs-card {
    flex: 1 1 240px; background: #1b2838;
    border: 1px solid #2f4257; border-radius: 3px; padding: 12px;
  }
  #fs-embed .fs-card h4 {
    margin: 0 0 8px; font-size: 12px; color: #66c0f4; font-weight: normal;
    border-bottom: 1px solid #2f4257; padding-bottom: 6px;
  }
  #fs-embed .fs-big { font-size: 30px; color: #a4d007; text-align: center; padding: 6px 0 2px; }
  #fs-embed .fs-sub { text-align: center; font-size: 11px; color: #8f98a0; margin-bottom: 10px; }
  #fs-embed .fs-stat { display: flex; justify-content: space-between; padding: 3px 0; font-size: 12px; }
  #fs-embed .fs-stat b { color: #66c0f4; font-weight: normal; }
  #fs-embed .fs-scope { font-size: 12px; color: #8f98a0; margin-bottom: 10px; }
  #fs-embed .fs-scope b { color: #66c0f4; }
  #fs-embed .fs-range { color: #5a6a7a; font-size: 11px; }
  #fs-embed .fs-note { font-size: 11px; color: #8f98a0; line-height: 1.5; margin-top: 10px;
    background: #0e1621; padding: 8px 10px; border-radius: 2px; border-left: 2px solid #4c6b91; }
  #fs-embed .fs-games { max-height: 190px; overflow-y: auto; font-size: 11px; }
  #fs-embed .fs-games div { display: flex; justify-content: space-between; padding: 2px 0;
    border-bottom: 1px solid #22303f; }
  #fs-embed .fs-games .fs-hit { color: #a4d007; }
  #fs-embed .fs-log { margin-top: 12px; max-height: 120px; overflow-y: auto;
    background: #0e1621; padding: 8px; font-size: 11px;
    font-family: Consolas, monospace; color: #7a8a9a; border-radius: 2px; }
  `;
  document.head.appendChild(Object.assign(document.createElement("style"), { textContent: css }));

  // ---------------- 插入页面（嵌入式，非悬浮） ----------------
  const panel = document.createElement("div");
  panel.id = "fs-embed";
  panel.innerHTML = `
    <div class="fs-head">
      <span>补充包闪卡统计</span>
      <span class="fs-toggle">收起 ▲</span>
    </div>
    <div class="fs-inner">
      <div class="fs-ctrl">
        <span>只统计最近</span>
        <input id="fs-limit" type="number" min="1" step="1" placeholder="全部">
        <span>包</span>
        <button id="fs-limit-save">应用</button>
        <span class="fs-sep">|</span>
        <button id="fs-scan">开始扫描</button>
        <button id="fs-stop" disabled>停止</button>
        <button id="fs-export">导出 CSV</button>
        <button id="fs-clear" class="fs-danger">清空</button>
      </div>
      <div id="fs-result"></div>
      <div class="fs-log" id="fs-log"></div>
    </div>`;

  function mount() {
    const firstRow = document.querySelector(".tradehistoryrow");
    let target = null;
    if (firstRow && firstRow.parentElement) {
      target = firstRow.parentElement;
      target.insertBefore(panel, firstRow);
    } else {
      target = document.querySelector("#mainContents")
            || document.querySelector(".maincontent")
            || document.body;
      target.insertBefore(panel, target.firstChild);
    }
  }
  mount();

  const $ = s => panel.querySelector(s);
  const logBox = $("#fs-log");
  function log(msg) {
    logBox.insertAdjacentHTML("afterbegin",
      `<div>[${new Date().toLocaleTimeString()}] ${msg}</div>`);
    while (logBox.children.length > 60) logBox.lastChild.remove();
  }

  const toggle = panel.querySelector(".fs-toggle");
  toggle.onclick = () => {
    panel.classList.toggle("fs-collapsed");
    toggle.textContent = panel.classList.contains("fs-collapsed") ? "展开 ▼" : "收起 ▲";
  };

  // ---------------- 渲染 ----------------
  function render() {
    const map = loadEvents();
    const limit = loadLimit();
    const total = Object.keys(map).length;
    const evts = recentEvents(map, limit);

    const packs = evts.length;
    const cards = evts.reduce((s, e) => s + e.cards.length, 0);
    const foilCards = evts.reduce((s, e) => s + e.foils.length, 0);
    const foilPacks = evts.filter(e => e.foils.length > 0).length;

    const [lo, hi] = wilson(foilCards, cards);
    const rate = cards ? foilCards / cards * 100 : 0;
    const [plo, phi] = wilson(foilPacks, packs);
    const packRate = packs ? foilPacks / packs * 100 : 0;

    const byGame = {};
    evts.forEach(e => {
      const g = byGame[e.game] || (byGame[e.game] = { n: 0, f: 0 });
      g.n += e.cards.length;
      g.f += e.foils.length;
    });
    const gameRows = Object.entries(byGame).sort((a, b) => b[1].n - a[1].n)
      .map(([g, v]) => `<div class="${v.f ? "fs-hit" : ""}">
        <span>${g || "(未知)"}</span><span>${v.f}/${v.n} 卡</span></div>`).join("");

    const newest = packs ? evts[0].time : "";
    const oldest = packs ? evts[packs - 1].time : "";

    $("#fs-result").innerHTML = `
      <div class="fs-scope">
        统计范围：${limit > 0
          ? `最近 <b>${limit}</b> 包（已抓取 ${total} 包）`
          : `<b>全部</b> ${total} 包`}
        ${packs ? `<span class="fs-range">　${oldest} → ${newest}</span>` : ""}
      </div>
      <div class="fs-grid">
        <div class="fs-card">
          <h4>主指标 · 单卡出闪率</h4>
          <div class="fs-big">${cards ? rate.toFixed(2) + "%" : "—"}</div>
          <div class="fs-sub">闪卡张数 ÷ 卡牌总数</div>
          <div class="fs-stat"><span>卡牌总数</span><b>${cards}</b></div>
          <div class="fs-stat"><span>闪卡张数</span><b>${foilCards}</b></div>
          <div class="fs-stat"><span>95% 置信区间</span>
            <b>${cards ? (lo*100).toFixed(2) + "% ~ " + (hi*100).toFixed(2) + "%" : "—"}</b></div>
        </div>
        <div class="fs-card">
          <h4>次要指标 · 单包含闪率</h4>
          <div class="fs-big" style="color:#66c0f4">${packs ? packRate.toFixed(2) + "%" : "—"}</div>
          <div class="fs-sub">含闪卡的包数 ÷ 总包数</div>
          <div class="fs-stat"><span>开包数</span><b>${packs}</b></div>
          <div class="fs-stat"><span>含闪卡的包数</span><b>${foilPacks}</b></div>
          <div class="fs-stat"><span>95% 置信区间</span>
            <b>${packs ? (plo*100).toFixed(2) + "% ~ " + (phi*100).toFixed(2) + "%" : "—"}</b></div>
        </div>
        ${gameRows ? `<div class="fs-card">
          <h4>按游戏（闪卡/卡牌）</h4>
          <div class="fs-games">${gameRows}</div>
        </div>` : ""}
      </div>
      ${cards ? `<div class="fs-note">
        当前样本 ${cards} 张卡（${packs} 包）。
        ${cards < 1500 ? "样本偏小，区间会很宽，先别急着下结论。"
                       : "样本尚可，可以开始参考。"}
        要把区间收窄到能区分 1% 和 0.5%，大概需要一万张卡左右。<br>
        两个指标的关系可以反推机制：若每张卡独立判定，单包含闪率应 ≈ 1-(1-p)³ ≈ 3 倍单卡率；
        若按包判定后再分配，两者关系会不同。
      </div>` : ""}`;
  }

  // ---------------- 扫描 ----------------
  async function scan() {
    if (scanning) return;
    scanning = true; abort = false;
    $("#fs-scan").disabled = true;
    $("#fs-stop").disabled = false;

    const map = loadEvents();
    const limit = loadLimit();
    const before = Object.keys(map).length;
    let cursor = readInitialCursor();
    let filterApp = true;
    let pages = 0, added = 0, dupStreak = 0, seen = 0;

    log(cursor ? "从当前页面游标开始" : "未取到游标，从头开始");
    if (limit > 0) log(`已设上限：抓够最近 ${limit} 包就停`);

    try {
      [...document.querySelectorAll(".tradehistoryrow")]
        .map(parseRow).filter(Boolean)
        .forEach(e => { seen++; if (!map[e.id]) { map[e.id] = e; added++; } });

      while (!abort && pages < MAX_PAGES && !(limit > 0 && seen >= limit)) {
        let data;
        try {
          data = await fetchPage(cursor, filterApp);
        } catch (err) {
          if (err.message === "RATE_LIMIT") {
            log("被限流，等 60 秒后重试…");
            await sleep(60000);
            continue;
          }
          throw err;
        }

        const rows = data.html ? parseHtml(data.html) : [];

        if (pages === 0 && rows.length === 0 && filterApp && !data.cursor) {
          log("应用过滤无效，改为全量扫描");
          filterApp = false;
          continue;
        }

        let newInPage = 0;
        rows.forEach(e => {
          seen++;
          if (!map[e.id]) { map[e.id] = e; added++; newInPage++; }
        });

        pages++;
        log(`第 ${pages} 页：开包记录 ${rows.length} 条，新增 ${newInPage}`
            + (limit > 0 ? `（累计 ${seen}/${limit}）` : ""));

        if (limit > 0 && seen >= limit) {
          log(`已达上限 ${limit} 包，停止翻页`);
          saveEvents(map);
          break;
        }

        dupStreak = newInPage === 0 ? dupStreak + 1 : 0;
        // 设了上限但还没抓够时，重复数据只说明这段历史已存过，应继续往更早翻
        if (dupStreak >= 3 && before > 0 && !(limit > 0 && seen < limit)) {
          log("连续 3 页无新数据，判定已追上历史进度");
          break;
        }

        if (!data.cursor) { log("已到库存历史末尾"); break; }
        cursor = data.cursor;

        saveEvents(map);
        render();
        await sleep(PAGE_DELAY_MS);
      }
    } catch (err) {
      log(`出错：${err.message}`);
    }

    saveEvents(map);
    render();
    log(`扫描结束：本次新增 ${added} 条，累计 ${Object.keys(map).length} 条`);

    scanning = false;
    $("#fs-scan").disabled = false;
    $("#fs-stop").disabled = true;
  }

  // ---------------- 事件 ----------------
  $("#fs-scan").onclick = scan;
  $("#fs-stop").onclick = () => { abort = true; log("正在停止…"); };

  $("#fs-limit-save").onclick = () => {
    const raw = $("#fs-limit").value.trim();
    const v = raw === "" ? 0 : parseInt(raw, 10);
    if (raw !== "" && (!Number.isFinite(v) || v < 1)) {
      alert("请填正整数，或留空表示统计全部");
      return;
    }
    saveLimit(v);
    log(v > 0 ? `统计范围设为最近 ${v} 包` : "统计范围设为全部");
    render();
  };
  $("#fs-limit").addEventListener("keydown", e => {
    if (e.key === "Enter") $("#fs-limit-save").click();
  });

  $("#fs-clear").onclick = () => {
    if (!confirm("确定清空所有已统计的数据？")) return;
    GM_deleteValue(STORE_KEY);
    log("已清空");
    render();
  };

  $("#fs-export").onclick = () => {
    const evts = recentEvents(loadEvents(), loadLimit());
    if (!evts.length) { alert("还没有数据"); return; }
    const esc = s => `"${String(s).replace(/"/g, '""')}"`;
    const csv = ["时间,游戏,卡牌,是否含闪卡,闪卡名称"]
      .concat(evts.map(e => [
        esc(e.time), esc(e.game), esc(e.cards.join(" | ")),
        e.foils.length ? "是" : "否", esc(e.foils.join(" | "))
      ].join(",")))
      .join("\n");
    const url = URL.createObjectURL(new Blob(["\ufeff" + csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `booster_foil_stats_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const saved = loadLimit();
  if (saved > 0) $("#fs-limit").value = saved;
  render();
  log("就绪。点「开始扫描」抓取库存历史。");
})();
