// ==UserScript==
// @name         Steam 补充包闪卡统计
// @namespace    https://github.com/Gravity2000
// @version      1.4.0
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
  const LIMIT_KEY = "foilstats_limit_v1";        // 补充包上限（按包数）
  const FARM_LIMIT_KEY = "foilstats_farmlimit_v1"; // 挂卡上限（按卡牌张数）
  const EN_BOOSTER_KEY = "foilstats_en_booster_v1"; // 是否统计补充包
  const EN_FARM_KEY = "foilstats_en_farm_v1";       // 是否统计挂卡掉落
  const BOOSTER_KEYWORDS = ["已拆开补充包", "Unpacked booster pack", "拆開補充包"];
  const FARM_KEYWORDS = ["因游戏时数而获取", "因遊戲時數而獲取",
                         "Earned", "Got an item drop", "游戏时数", "遊戲時數"];
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
  const loadFarmLimit = () => {
    const v = parseInt(GM_getValue(FARM_LIMIT_KEY, 0), 10);
    return Number.isFinite(v) && v > 0 ? v : 0;
  };
  const saveFarmLimit = v => GM_setValue(FARM_LIMIT_KEY, v);
  // 开关默认：补充包开，挂卡关（挂卡是可选的附加统计，不主动打扰）
  const loadEnBooster = () => GM_getValue(EN_BOOSTER_KEY, true) !== false;
  const loadEnFarm = () => GM_getValue(EN_FARM_KEY, false) === true;
  const saveEnabled = (b, f) => { GM_setValue(EN_BOOSTER_KEY, b); GM_setValue(EN_FARM_KEY, f); };

  // ---------------- 工具 ----------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isFoilName = n => FOIL_MARKERS.some(m => n.includes(m));
  const isBoosterEvent = d => BOOSTER_KEYWORDS.some(k => d.includes(k));
  const isFarmEvent = d => !isBoosterEvent(d) && FARM_KEYWORDS.some(k => d.includes(k));

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
    const descEl = row.querySelector(".tradehistory_event_description");
    if (!descEl) return null;
    const desc = descEl.textContent.trim();

    const booster = isBoosterEvent(desc);
    const farm = isFarmEvent(desc);
    if (!booster && !farm) return null;

    const groups = row.querySelectorAll(".tradehistory_items");
    if (!groups.length) return null;

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
    // 开包必须是「减补充包 + 加卡牌」的成对结构，缺一不算
    if (booster && !boosterName) return null;

    const anyItem = row.querySelector("[id^='history']");
    const id = anyItem
      ? anyItem.id.replace(/^history/, "").replace(/_item\d+$/, "")
      : `${desc}|${boosterName}|${received.join(",")}|${Math.random()}`;

    const dateEl = row.querySelector(".tradehistory_date");
    const time = dateEl ? dateEl.textContent.replace(/\s+/g, " ").trim() : "";

    // 挂卡掉落没有「包」的概念，游戏名从卡牌本身取不到，标记为掉落
    const game = booster
      ? boosterName.replace(/\s*补充包\s*$/, "").replace(/\s*Booster Pack\s*$/i, "").trim()
      : "";

    return {
      id, time, ts: parseTime(time),
      kind: booster ? "booster" : "farm",
      game,
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
  #fs-embed .fs-chk { display: inline-flex; align-items: center; gap: 4px;
    cursor: pointer; color: #c7d5e0; user-select: none; }
  #fs-embed .fs-chk input { cursor: pointer; accent-color: #4c6b91; }
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
        <label class="fs-chk"><input type="checkbox" id="fs-en-booster" checked> 补充包</label>
        <span>最近</span>
        <input id="fs-limit" type="number" min="1" step="1" placeholder="全部">
        <span>包</span>
        <span class="fs-sep">·</span>
        <label class="fs-chk"><input type="checkbox" id="fs-en-farm"> 挂卡掉落</label>
        <span>最近</span>
        <input id="fs-farm-limit" type="number" min="1" step="1" placeholder="全部">
        <span>张卡</span>
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
  // 两个渠道各自独立截取，互不影响：
  //   补充包按「包数」取最近 N 包
  //   挂卡按「卡牌张数」取最近 N 张（记录会合并，所以逐条累加张数直到够）
  function splitScope(map, limit, farmLimit) {
    const all = Object.values(map).sort((a, b) => (b.ts || 0) - (a.ts || 0));
    const allBoosters = all.filter(e => e.kind !== "farm");
    const allFarms = all.filter(e => e.kind === "farm");

    const boosters = limit > 0 ? allBoosters.slice(0, limit) : allBoosters;

    let farms = allFarms;
    if (farmLimit > 0) {
      farms = [];
      let acc = 0;
      for (const e of allFarms) {
        if (acc >= farmLimit) break;
        farms.push(e);
        acc += e.cards.length;
      }
    }

    return {
      boosters, farms,
      totalBoosters: allBoosters.length,
      totalFarmCards: allFarms.reduce((s, e) => s + e.cards.length, 0)
    };
  }

  function tally(list) {
    const cards = list.reduce((s, e) => s + e.cards.length, 0);
    const foils = list.reduce((s, e) => s + e.foils.length, 0);
    const [lo, hi] = wilson(foils, cards);
    return { n: list.length, cards, foils, lo, hi,
             rate: cards ? foils / cards * 100 : 0 };
  }

  const pct = v => (v * 100).toFixed(2) + "%";
  const ci = t => t.cards ? pct(t.lo) + " ~ " + pct(t.hi) : "—";

  function render() {
    const map = loadEvents();
    const limit = loadLimit();
    const farmLimit = loadFarmLimit();
    const enB = loadEnBooster();
    const enF = loadEnFarm();
    const { boosters, farms, totalBoosters, totalFarmCards } =
      splitScope(map, enB ? limit : 0, enF ? farmLimit : 0);

    const B = tally(boosters);
    const F = tally(farms);

    // 单包含闪率（仅补充包有意义）
    const foilPacks = boosters.filter(e => e.foils.length > 0).length;
    const [plo, phi] = wilson(foilPacks, B.n);
    const packRate = B.n ? foilPacks / B.n * 100 : 0;

    // 两个渠道的差异是否显著：置信区间不重叠即为显著
    let cmp = "";
    if (B.cards >= 100 && F.cards >= 100) {
      const overlap = !(B.hi < F.lo || F.hi < B.lo);
      cmp = overlap
        ? `两者置信区间重叠，<b>目前看不出显著差异</b>，数据支持「两个渠道掉率相同」。`
        : `两者置信区间不重叠，<b>差异显著</b> —— 补充包与挂卡的闪卡掉率可能不是同一个数。`;
    } else {
      cmp = "两边样本都超过 100 张卡之后，这里会给出差异是否显著的判断。";
    }

    const byGame = {};
    boosters.forEach(e => {
      const g = byGame[e.game] || (byGame[e.game] = { n: 0, f: 0 });
      g.n += e.cards.length;
      g.f += e.foils.length;
    });
    const gameRows = Object.entries(byGame).sort((a, b) => b[1].n - a[1].n)
      .map(([g, v]) => `<div class="${v.f ? "fs-hit" : ""}">
        <span>${g || "(未知)"}</span><span>${v.f}/${v.n} 卡</span></div>`).join("");

    const newest = B.n ? boosters[0].time : "";
    const oldest = B.n ? boosters[B.n - 1].time : "";

    $("#fs-result").innerHTML = `
      <div class="fs-scope">
        ${enB ? `<div>补充包：${limit > 0 ? `最近 <b>${limit}</b> 包` : `<b>全部</b>`}
          <span class="fs-range">　实际 ${B.n} 包 / 共抓取 ${totalBoosters} 包
          ${B.n ? `　${oldest} → ${newest}` : ""}</span></div>` : ""}
        ${enF ? `<div>挂卡掉落：${farmLimit > 0 ? `最近 <b>${farmLimit}</b> 张卡` : `<b>全部</b>`}
          <span class="fs-range">　实际 ${F.cards} 张 / 共抓取 ${totalFarmCards} 张
          ${F.n ? `　${farms[F.n-1].time} → ${farms[0].time}` : ""}</span></div>` : ""}
        ${!enB && !enF ? `<div style="color:#c07a7a">两个渠道都关掉了，勾选至少一个再看结果。</div>` : ""}
      </div>
      <div class="fs-grid">
        ${enB ? `<div class="fs-card">
          <h4>补充包 · 单卡出闪率</h4>
          <div class="fs-big">${B.cards ? B.rate.toFixed(2) + "%" : "—"}</div>
          <div class="fs-sub">闪卡张数 ÷ 卡牌总数</div>
          <div class="fs-stat"><span>开包数</span><b>${B.n}</b></div>
          <div class="fs-stat"><span>卡牌总数</span><b>${B.cards}</b></div>
          <div class="fs-stat"><span>闪卡张数</span><b>${B.foils}</b></div>
          <div class="fs-stat"><span>95% 置信区间</span><b>${ci(B)}</b></div>
        </div>` : ""}
        ${enF ? `<div class="fs-card">
          <h4>挂卡掉落 · 单卡出闪率</h4>
          <div class="fs-big" style="color:#f4a460">${F.cards ? F.rate.toFixed(2) + "%" : "—"}</div>
          <div class="fs-sub">闪卡张数 ÷ 卡牌总数</div>
          <div class="fs-stat"><span>掉落记录数</span><b>${F.n}</b></div>
          <div class="fs-stat"><span>卡牌总数</span><b>${F.cards}</b></div>
          <div class="fs-stat"><span>闪卡张数</span><b>${F.foils}</b></div>
          <div class="fs-stat"><span>95% 置信区间</span><b>${ci(F)}</b></div>
        </div>` : ""}
        ${enB ? `<div class="fs-card">
          <h4>补充包 · 单包含闪率</h4>
          <div class="fs-big" style="color:#66c0f4">${B.n ? packRate.toFixed(2) + "%" : "—"}</div>
          <div class="fs-sub">含闪卡的包数 ÷ 总包数</div>
          <div class="fs-stat"><span>含闪卡的包数</span><b>${foilPacks}</b></div>
          <div class="fs-stat"><span>95% 置信区间</span>
            <b>${B.n ? pct(plo) + " ~ " + pct(phi) : "—"}</b></div>
        </div>` : ""}
        ${(enB && gameRows) ? `<div class="fs-card">
          <h4>补充包按游戏（闪卡/卡牌）</h4>
          <div class="fs-games">${gameRows}</div>
        </div>` : ""}
      </div>
      ${((enB && B.cards) || (enF && F.cards)) ? `<div class="fs-note">
        ${(enB && enF) ? `<b style="color:#66c0f4">两个渠道对比：</b>${cmp}<br><br>` : ""}
        当前样本：${enB ? `补充包 ${B.cards} 张卡（${B.n} 包）` : ""}${(enB && enF) ? "，" : ""}${enF ? `挂卡 ${F.cards} 张卡` : ""}。
        ${(enB && enF) ? "两个渠道的上限独立设置，时间范围可能不同 —— 对比时留意这点。" : ""}
        ${(enB && B.cards < 1500) ? "补充包样本偏小，区间会很宽，先别急着下结论。" : ""}
        要把区间收窄到能区分 1% 和 0.5%，大概需要一万张卡。<br><br>
        ${enF ? `<b style="color:#66c0f4">注意：</b>挂卡掉落的记录会把同一时段的多次掉落合并成一条
        （一条里可能有 1~2 张卡），所以分母按<b>卡牌张数</b>算，不是记录条数。<br>` : ""}
        ${enB ? `补充包的单卡率与单包率的关系可反推机制：若每张卡独立判定，
        单包含闪率应 ≈ 1-(1-p)³ ≈ 3 倍单卡率。` : ""}
      </div>` : ""}`;
  }

  // ---------------- 扫描 ----------------
  async function scan() {
    if (scanning) return;
    scanning = true; abort = false;
    $("#fs-scan").disabled = true;
    $("#fs-stop").disabled = false;

    const map = loadEvents();
    const enB = loadEnBooster(), enF = loadEnFarm();
    const limit = enB ? loadLimit() : 0;
    const farmLimit = enF ? loadFarmLimit() : 0;
    const before = Object.keys(map).length;
    let cursor = readInitialCursor();
    let filterApp = true;
    let pages = 0, added = 0, dupStreak = 0;
    let seen = 0;       // 已扫到的补充包数
    let farmSeen = 0;   // 已扫到的挂卡卡牌张数

    // 两个上限彼此独立：任一未达标就继续翻页
    const boosterDone = () => limit === 0 || seen >= limit;
    const farmDone = () => farmLimit === 0 || farmSeen >= farmLimit;
    const allDone = () => (limit > 0 || farmLimit > 0) && boosterDone() && farmDone();

    log(cursor ? "从当前页面游标开始" : "未取到游标，从头开始");
    if (limit > 0) log(`补充包上限：${limit} 包`);
    if (farmLimit > 0) log(`挂卡上限：${farmLimit} 张卡`);
    if (!limit && !farmLimit) log("未设上限，将扫描到历史末尾");

    try {
      [...document.querySelectorAll(".tradehistoryrow")]
        .map(parseRow).filter(Boolean)
        .forEach(e => {
          if (e.kind === "farm") farmSeen += e.cards.length;
          else seen++;
          if (!map[e.id]) { map[e.id] = e; added++; }
        });

      if (allDone()) log("当前页已满足全部上限，无需翻页");

      while (!abort && pages < MAX_PAGES && !allDone()) {
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

        let newInPage = 0, boostersInPage = 0, farmCardsInPage = 0;
        rows.forEach(e => {
          if (e.kind === "farm") { farmSeen += e.cards.length; farmCardsInPage += e.cards.length; }
          else { seen++; boostersInPage++; }
          if (!map[e.id]) { map[e.id] = e; added++; newInPage++; }
        });

        pages++;
        const prog = [];
        if (limit > 0) prog.push(`包 ${Math.min(seen, limit)}/${limit}`);
        if (farmLimit > 0) prog.push(`挂卡 ${Math.min(farmSeen, farmLimit)}/${farmLimit} 张`);
        log(`第 ${pages} 页：开包 ${boostersInPage} 条 / 挂卡 ${farmCardsInPage} 张，`
            + `新增 ${newInPage}` + (prog.length ? `（${prog.join("，")}）` : ""));

        if (allDone()) {
          log("已达设定上限，停止翻页");
          saveEvents(map);
          break;
        }

        dupStreak = newInPage === 0 ? dupStreak + 1 : 0;
        // 上限调大后，前几页必然全是旧数据 —— 此时不能判定为「已追上」
        const stillWanting = (limit > 0 && seen < limit)
                          || (farmLimit > 0 && farmSeen < farmLimit);
        if (dupStreak >= 3 && before > 0 && !stillWanting) {
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

  function readLimitInput(sel, label) {
    const raw = $(sel).value.trim();
    if (raw === "") return 0;
    const v = parseInt(raw, 10);
    if (!Number.isFinite(v) || v < 1) {
      alert(`${label}请填正整数，或留空表示统计全部`);
      return null;
    }
    return v;
  }

  $("#fs-limit-save").onclick = () => {
    const v = readLimitInput("#fs-limit", "补充包上限");
    if (v === null) return;
    const fv = readLimitInput("#fs-farm-limit", "挂卡上限");
    if (fv === null) return;
    const b = $("#fs-en-booster").checked;
    const f = $("#fs-en-farm").checked;
    if (!b && !f) { alert("至少要勾选一个统计渠道"); return; }
    saveLimit(v); saveFarmLimit(fv); saveEnabled(b, f);
    const parts = [];
    if (b) parts.push(`补充包 ${v > 0 ? "最近 " + v + " 包" : "全部"}`);
    if (f) parts.push(`挂卡 ${fv > 0 ? "最近 " + fv + " 张卡" : "全部"}`);
    log("范围已更新 —— " + parts.join("，") + (b && f ? "" : "（另一渠道已关闭）"));
    render();
  };
  ["#fs-limit", "#fs-farm-limit"].forEach(sel =>
    $(sel).addEventListener("keydown", e => {
      if (e.key === "Enter") $("#fs-limit-save").click();
    }));

  $("#fs-clear").onclick = () => {
    if (!confirm("确定清空所有已统计的数据？")) return;
    GM_deleteValue(STORE_KEY);
    log("已清空");
    render();
  };

  $("#fs-export").onclick = () => {
    const eb = loadEnBooster(), ef = loadEnFarm();
    const { boosters, farms } = splitScope(loadEvents(),
      eb ? loadLimit() : 0, ef ? loadFarmLimit() : 0);
    const evts = (eb ? boosters : []).concat(ef ? farms : [])
      .sort((a, b) => (b.ts || 0) - (a.ts || 0));
    if (!evts.length) { alert("还没有数据"); return; }
    const esc = s => `"${String(s).replace(/"/g, '""')}"`;
    const csv = ["时间,来源,游戏,卡牌数,卡牌,闪卡数,闪卡名称"]
      .concat(evts.map(e => [
        esc(e.time),
        e.kind === "farm" ? "挂卡掉落" : "补充包",
        esc(e.game), e.cards.length, esc(e.cards.join(" | ")),
        e.foils.length, esc(e.foils.join(" | "))
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
  const savedFarm = loadFarmLimit();
  if (savedFarm > 0) $("#fs-farm-limit").value = savedFarm;
  $("#fs-en-booster").checked = loadEnBooster();
  $("#fs-en-farm").checked = loadEnFarm();
  render();
  log("就绪。点「开始扫描」抓取库存历史。");
})();
