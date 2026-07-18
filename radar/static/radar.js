"use strict";

const TAU = Math.PI * 2;
const SWEEP_MS = 6000;
const POLL_MS = 2000;
const TRAIL_MAX = 30;
const RANGE_STEPS = [10, 25, 50, 100, 150, 200, 250, 300];
const EMER_SQK = new Set(["7500", "7600", "7700"]);

const canvas = document.getElementById("scope");
const ctx = canvas.getContext("2d");
const $ = (id) => document.getElementById(id);

const state = {
  aircraft: new Map(), // hex -> {info, trail: [[lat, lon], ...]}
  receiver: { lat: null, lon: null, site_name: "ADSB-PI", range_nm: 100 },
  rangeMode: "auto",
  rangeNm: 100,
  selected: null,
  decoderOk: false,
  msgRate: 0,
  lastMessages: null,
  lastPollT: 0,
  failCount: 0,
  center: null,
};

// ---------- geometry ----------

function distBrgNm(lat1, lon1, lat2, lon2) {
  const R = 3440.065; // earth radius, nautical miles
  const p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  const d = 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  const b = (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  return [d, b];
}

function altColor(alt, a) {
  const f = Math.min(1, Math.max(0, (alt || 0) / 40000));
  const r = Math.round(60 + 100 * f);
  const g = Math.round(220 + 35 * f);
  const b = Math.round(130 + 95 * f);
  return `rgba(${r},${g},${b},${a})`;
}

function isEmergency(ac) {
  return EMER_SQK.has(String(ac.squawk)) || (ac.emergency && ac.emergency !== "none");
}

// ---------- data ----------

async function poll() {
  try {
    const r = await fetch("/api/aircraft", { cache: "no-store" });
    const d = await r.json();
    state.decoderOk = !!d.ok;
    if (d.receiver) state.receiver = { ...state.receiver, ...d.receiver };
    const now = performance.now();
    if (state.lastMessages != null && d.messages != null) {
      const dt = (now - state.lastPollT) / 1000;
      if (dt > 0) {
        const inst = Math.max(0, (d.messages - state.lastMessages) / dt);
        state.msgRate = state.msgRate * 0.6 + inst * 0.4;
      }
    }
    state.lastMessages = d.messages;
    state.lastPollT = now;
    ingest(d.aircraft || []);
    state.failCount = 0;
  } catch (e) {
    state.failCount++;
    if (state.failCount > 3) state.decoderOk = false;
  }
  updateHud();
  updateSidebar();
}

function ingest(list) {
  const seenHex = new Set();
  for (const ac of list) {
    if (!ac.hex) continue;
    seenHex.add(ac.hex);
    let e = state.aircraft.get(ac.hex);
    if (!e) {
      e = { trail: [] };
      state.aircraft.set(ac.hex, e);
    }
    e.info = ac;
    if (typeof ac.lat === "number" && typeof ac.lon === "number") {
      const last = e.trail[e.trail.length - 1];
      if (!last || Math.abs(last[0] - ac.lat) > 0.001 || Math.abs(last[1] - ac.lon) > 0.001) {
        e.trail.push([ac.lat, ac.lon]);
        if (e.trail.length > TRAIL_MAX) e.trail.shift();
      }
    }
  }
  for (const [hex, e] of state.aircraft) {
    if (!seenHex.has(hex) || (e.info.seen ?? 0) > 180) {
      state.aircraft.delete(hex);
      if (state.selected === hex) state.selected = null;
    }
  }
}

function computeCenter() {
  const r = state.receiver;
  if (typeof r.lat === "number" && typeof r.lon === "number") {
    state.center = [r.lat, r.lon];
    return;
  }
  let n = 0, la = 0, lo = 0;
  for (const e of state.aircraft.values()) {
    const a = e.info;
    if (typeof a.lat === "number" && typeof a.lon === "number") {
      n++; la += a.lat; lo += a.lon;
    }
  }
  state.center = n ? [la / n, lo / n] : null;
}

function updateRange() {
  if (state.rangeMode !== "auto") {
    state.rangeNm = state.rangeMode;
    return;
  }
  let max = 0;
  if (state.center) {
    for (const e of state.aircraft.values()) {
      const a = e.info;
      if (typeof a.lat !== "number" || (a.seen_pos ?? 999) > 60) continue;
      const [d] = distBrgNm(state.center[0], state.center[1], a.lat, a.lon);
      if (d > max) max = d;
    }
  }
  if (max === 0) {
    state.rangeNm = state.receiver.range_nm || 100;
    return;
  }
  for (const s of RANGE_STEPS) {
    if (s >= max * 1.15) { state.rangeNm = s; return; }
  }
  state.rangeNm = RANGE_STEPS[RANGE_STEPS.length - 1];
}

// ---------- drawing ----------

function drawGrid(cx, cy, radius) {
  ctx.save();
  ctx.translate(cx, cy);
  for (let i = 1; i <= 4; i++) {
    const r = radius * i / 4;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, TAU);
    ctx.strokeStyle = i === 4 ? "rgba(80,255,170,0.55)" : "rgba(64,200,140,0.25)";
    ctx.lineWidth = i === 4 ? 1.5 : 1;
    ctx.stroke();
    const nm = Math.round(state.rangeNm * i / 4);
    ctx.fillStyle = "rgba(100,220,160,0.5)";
    ctx.font = "10px 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillText(String(nm), 0, -r + 12);
  }
  ctx.textBaseline = "middle";
  const names = { 0: "N", 90: "E", 180: "S", 270: "W" };
  for (let deg = 0; deg < 360; deg += 30) {
    const a = deg * Math.PI / 180;
    const card = deg % 90 === 0;
    const len = card ? 14 : 8;
    ctx.beginPath();
    ctx.moveTo(Math.sin(a) * (radius - len), -Math.cos(a) * (radius - len));
    ctx.lineTo(Math.sin(a) * radius, -Math.cos(a) * radius);
    ctx.strokeStyle = "rgba(80,255,170,0.5)";
    ctx.lineWidth = card ? 2 : 1;
    ctx.stroke();
    const label = card ? names[deg] : String(deg / 10).padStart(2, "0");
    ctx.fillStyle = card ? "rgba(140,255,190,0.8)" : "rgba(100,220,160,0.45)";
    ctx.font = (card ? "bold 13px" : "10px") + " 'Courier New', monospace";
    ctx.fillText(label, Math.sin(a) * (radius - 30), -Math.cos(a) * (radius - 30));
  }
  ctx.restore();
}

function drawSweep(cx, cy, radius, sweep) {
  const SLICES = 56, TRAIL = 0.55;
  ctx.save();
  ctx.translate(cx, cy);
  for (let i = 0; i < SLICES; i++) {
    const a0 = sweep - TRAIL * i / SLICES - Math.PI / 2;
    const a1 = sweep - TRAIL * (i + 1) / SLICES - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, radius, a0, a1, true);
    ctx.closePath();
    ctx.fillStyle = `rgba(90,255,160,${(0.16 * (1 - i / SLICES)).toFixed(3)})`;
    ctx.fill();
  }
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(Math.sin(sweep) * radius, -Math.cos(sweep) * radius);
  ctx.strokeStyle = "rgba(170,255,210,0.85)";
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.restore();
}

function drawRx(cx, cy) {
  ctx.strokeStyle = "rgba(140,255,190,0.7)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(cx - 6, cy); ctx.lineTo(cx + 6, cy);
  ctx.moveTo(cx, cy - 6); ctx.lineTo(cx, cy + 6);
  ctx.stroke();
}

function drawTargets(cx, cy, scale, sweep, tms) {
  const [clat, clon] = state.center;
  for (const [hex, e] of state.aircraft) {
    const ac = e.info;
    if (typeof ac.lat !== "number" || typeof ac.lon !== "number") continue;
    if ((ac.seen_pos ?? 0) > 60) continue;
    const [dist, brg] = distBrgNm(clat, clon, ac.lat, ac.lon);
    if (dist > state.rangeNm) continue;
    const th = brg * Math.PI / 180;
    const x = cx + dist * scale * Math.sin(th);
    const y = cy - dist * scale * Math.cos(th);

    let dAng = (sweep - th) % TAU;
    if (dAng < 0) dAng += TAU;
    const glow = Math.exp(-4.0 * dAng / TAU);
    const stale = (ac.seen_pos ?? 0) > 15;
    const sel = state.selected === hex;
    const emer = isEmergency(ac);
    let alpha = sel ? 1 : Math.max(stale ? 0.10 : 0.22, glow);
    if (emer) alpha = 0.55 + 0.45 * Math.sin(tms / 160);

    const onGround = ac.alt_baro === "ground";
    const alt = typeof ac.alt_baro === "number" ? ac.alt_baro : 0;
    const acColor = emer ? `rgba(255,85,85,${alpha})`
      : onGround ? `rgba(255,179,71,${alpha})`
      : sel ? `rgba(255,255,255,${alpha})`
      : altColor(alt, alpha);

    if (e.trail.length > 1) {
      for (let i = 0; i < e.trail.length; i++) {
        const [la, lo] = e.trail[i];
        const [td, tb] = distBrgNm(clat, clon, la, lo);
        if (td > state.rangeNm) continue;
        const tth = tb * Math.PI / 180;
        const tx = cx + td * scale * Math.sin(tth);
        const ty = cy - td * scale * Math.cos(tth);
        const ta = (i / e.trail.length) * 0.35 * Math.max(alpha, 0.3);
        ctx.fillStyle = onGround ? `rgba(255,179,71,${ta})` : altColor(alt, ta);
        ctx.fillRect(tx - 1.2, ty - 1.2, 2.4, 2.4);
      }
    }

    const gs = ac.gs ?? 0;
    const trk = ac.track ?? ac.true_heading;
    if (!onGround && gs > 50 && typeof trk === "number") {
      const v = trk * Math.PI / 180;
      const len = (gs / 30) * scale; // 2 minutes of travel
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.sin(v) * len, y - Math.cos(v) * len);
      ctx.strokeStyle = acColor;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    const s = sel ? 4.5 : 3.4;
    if (stale && !sel) {
      ctx.strokeStyle = acColor;
      ctx.lineWidth = 1.2;
      ctx.strokeRect(-s, -s, 2 * s, 2 * s);
    } else {
      ctx.fillStyle = acColor;
      ctx.fillRect(-s, -s, 2 * s, 2 * s);
    }
    ctx.restore();

    if (sel) {
      ctx.beginPath();
      ctx.arc(x, y, 9, 0, TAU);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    const fl = (ac.flight || "").trim() || hex.toUpperCase();
    const altTxt = onGround ? "GND" : String(Math.round(alt / 100)).padStart(3, " ");
    const arrow = (ac.baro_rate ?? 0) > 300 ? "↑" : (ac.baro_rate ?? 0) < -300 ? "↓" : " ";
    const spd = ac.gs != null ? String(Math.round(ac.gs)).padStart(3, "0") : "---";
    const la = Math.max(alpha, sel ? 1 : 0.55);
    ctx.font = "11px 'Courier New', monospace";
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    const bx = x + 12;
    const by = y - 2;
    ctx.fillStyle = emer ? `rgba(255,85,85,${la})` : sel ? `rgba(255,255,255,${la})` : altColor(alt, la);
    ctx.fillText(fl, bx, by);
    ctx.fillText(`${altTxt}${arrow}${spd}`, bx, by + 13);
    if (sel) {
      ctx.fillStyle = "rgba(255,255,255,0.85)";
      ctx.fillText(`${dist.toFixed(1)}nm ${String(Math.round(brg)).padStart(3, "0")}° ${ac.squawk || ""}`, bx, by + 26);
    }
  }
}

function drawCenterMsg(w, h, line1, line2) {
  ctx.textAlign = "center";
  ctx.fillStyle = "rgba(255,179,71,0.9)";
  ctx.font = "bold 16px 'Courier New', monospace";
  ctx.fillText(line1, w / 2, h / 2 - 10);
  ctx.font = "12px 'Courier New', monospace";
  ctx.fillText(line2, w / 2, h / 2 + 14);
}

function draw(tms) {
  requestAnimationFrame(draw);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.fillStyle = "#02080a";
  ctx.fillRect(0, 0, w, h);
  computeCenter();
  updateRange();
  const cx = w / 2, cy = h / 2;
  const radius = Math.min(w, h) * 0.44;
  if (!state.center) {
    drawCenterMsg(w, h, "NO POSITION REFERENCE", "set receiver location in settings or wait for traffic");
    return;
  }
  const scale = radius / state.rangeNm;
  drawGrid(cx, cy, radius);
  const sweep = (tms % SWEEP_MS) / SWEEP_MS * TAU;
  drawSweep(cx, cy, radius, sweep);
  drawRx(cx, cy);
  drawTargets(cx, cy, scale, sweep, tms);
}

// ---------- HUD / panels ----------

function updateHud() {
  let pos = 0;
  for (const e of state.aircraft.values()) {
    if (typeof e.info.lat === "number" && (e.info.seen_pos ?? 99) <= 60) pos++;
  }
  $("hud-count").textContent = `AC ${state.aircraft.size}·${pos}`;
  $("hud-msgs").textContent = `${state.msgRate.toFixed(0)} msg/s`;
  $("hud-site").textContent = state.receiver.site_name || "ADSB-PI";
  $("hud-maxrange").textContent = `RNG ${state.rangeNm}`;
  const banner = $("banner");
  banner.hidden = state.decoderOk;
  if (!state.decoderOk) banner.textContent = "DECODER OFFLINE — IS READSB RUNNING?";
}

function updateSidebar() {
  const tbody = $("ac-rows");
  const sidebar = $("sidebar");
  if (!tbody || sidebar.hidden) return;
  computeCenter();
  const rows = [];
  for (const [hex, e] of state.aircraft) {
    const ac = e.info;
    let dist = null;
    if (state.center && typeof ac.lat === "number") {
      [dist] = distBrgNm(state.center[0], state.center[1], ac.lat, ac.lon);
    }
    rows.push({ hex, ac, dist });
  }
  rows.sort((a, b) => (a.dist ?? 1e9) - (b.dist ?? 1e9));
  tbody.innerHTML = rows.map(({ hex, ac, dist }) => {
    const fl = (ac.flight || "").trim() || hex.toUpperCase();
    const alt = ac.alt_baro === "ground" ? "GND"
      : typeof ac.alt_baro === "number" ? ac.alt_baro : "—";
    const spd = ac.gs != null ? Math.round(ac.gs) : "—";
    const d = dist != null ? dist.toFixed(1) : "—";
    const sq = ac.squawk || "";
    const rssi = ac.rssi != null ? ac.rssi.toFixed(0) : "—";
    const cls = state.selected === hex ? ' class="sel"' : isEmergency(ac) ? ' class="emer"' : "";
    return `<tr data-hex="${hex}"${cls}><td>${fl}</td><td>${alt}</td><td>${spd}</td><td>${d}</td><td>${sq}</td><td>${rssi}</td></tr>`;
  }).join("");
}

// ---------- events ----------

function setupEvents() {
  document.querySelectorAll("#range-buttons button").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll("#range-buttons button").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      state.rangeMode = b.dataset.range === "auto" ? "auto" : Number(b.dataset.range);
    });
  });

  canvas.addEventListener("click", (ev) => {
    if (!state.center) return;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const cx = w / 2, cy = h / 2;
    const radius = Math.min(w, h) * 0.44;
    const scale = radius / state.rangeNm;
    let best = null, bestD = 14;
    for (const [hex, e] of state.aircraft) {
      const ac = e.info;
      if (typeof ac.lat !== "number" || (ac.seen_pos ?? 0) > 60) continue;
      const [dist, brg] = distBrgNm(state.center[0], state.center[1], ac.lat, ac.lon);
      if (dist > state.rangeNm) continue;
      const th = brg * Math.PI / 180;
      const x = cx + dist * scale * Math.sin(th);
      const y = cy - dist * scale * Math.cos(th);
      const d = Math.hypot(ev.clientX - x, ev.clientY - y);
      if (d < bestD) { bestD = d; best = hex; }
    }
    state.selected = best;
    updateSidebar();
  });

  $("ac-rows").addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr");
    if (!tr) return;
    state.selected = state.selected === tr.dataset.hex ? null : tr.dataset.hex;
    updateSidebar();
  });

  $("btn-sidebar").addEventListener("click", () => {
    const s = $("sidebar");
    s.hidden = !s.hidden;
    updateSidebar();
  });

  $("btn-settings").addEventListener("click", () => {
    const p = $("settings");
    p.hidden = !p.hidden;
    if (!p.hidden) {
      $("set-site").value = state.receiver.site_name || "";
      $("set-lat").value = state.receiver.lat ?? "";
      $("set-lon").value = state.receiver.lon ?? "";
    }
  });
  $("set-close").addEventListener("click", () => { $("settings").hidden = true; });
  $("set-geo").addEventListener("click", () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition((pos) => {
      $("set-lat").value = pos.coords.latitude.toFixed(5);
      $("set-lon").value = pos.coords.longitude.toFixed(5);
    });
  });
  $("set-save").addEventListener("click", async () => {
    const body = { site_name: $("set-site").value };
    const lat = parseFloat($("set-lat").value);
    const lon = parseFloat($("set-lon").value);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) {
      body.lat = lat;
      body.lon = lon;
    }
    try {
      const r = await fetch("/api/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (d.ok) {
        state.receiver = { ...state.receiver, ...d.config };
        $("settings").hidden = true;
      }
    } catch (e) { /* keep panel open */ }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("settings").hidden = true;
      $("sidebar").hidden = true;
    }
  });

  window.addEventListener("resize", resize);
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = canvas.clientHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ---------- init ----------

if (new URLSearchParams(location.search).has("kiosk")) {
  document.body.classList.add("kiosk");
}

resize();
setupEvents();
setInterval(() => {
  $("hud-clock").textContent = new Date().toISOString().slice(11, 19) + "Z";
}, 1000);
poll();
setInterval(poll, POLL_MS);
requestAnimationFrame(draw);
