import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { createBackend } from "./backends/index.js";
import { HandyController, parseChainInput } from "./controller.js";
import { PermissionStore } from "./permissions.js";
import { HANDY_VERSION } from "./version.js";
function readJsonBody(req, maxBytes = 65_536) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let total = 0;
        req.on("data", (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                reject(new Error("Request body too large."));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8").trim();
            if (!text) {
                resolve({});
                return;
            }
            try {
                const parsed = JSON.parse(text);
                if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
                    reject(new Error("Expected JSON object body."));
                    return;
                }
                resolve(parsed);
            }
            catch (err) {
                reject(err);
            }
        });
        req.on("error", reject);
    });
}
function sendJson(res, status, body) {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
    });
    res.end(payload);
}
function renderHtml(token) {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Handy Control Panel v${HANDY_VERSION}</title>
  <style>
    :root {
      --bg: #0b1120;
      --panel: #111827;
      --border: #1f2937;
      --text: #f8fafc;
      --muted: #94a3b8;
      --accent: #0ea5e9;
      --green: #10b981;
      --amber: #f59e0b;
      --red: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
    }
    header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 14px 20px;
      background: var(--panel);
      border-bottom: 1px solid var(--border);
    }
    .brand { display: flex; align-items: center; gap: 10px; font-weight: 700; font-size: 16px; }
    .badge {
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    .badge.on { background: rgba(16,185,129,0.18); color: #34d399; border: 1px solid rgba(16,185,129,0.4); }
    .badge.view { background: rgba(245,158,11,0.18); color: #fbbf24; border: 1px solid rgba(245,158,11,0.4); }
    .badge.off { background: rgba(239,68,68,0.18); color: #f87171; border: 1px solid rgba(239,68,68,0.4); }
    .controls { display: flex; flex-wrap: wrap; gap: 8px; }
    button {
      cursor: pointer;
      border: 1px solid var(--border);
      background: #1e293b;
      color: var(--text);
      padding: 8px 13px;
      border-radius: 8px;
      font-weight: 600;
      font-size: 13px;
      transition: filter 0.12s;
    }
    button:hover { filter: brightness(1.12); }
    button.btn-green { background: #059669; border-color: #10b981; }
    button.btn-amber { background: #b45309; border-color: #f59e0b; }
    button.btn-red { background: #dc2626; border-color: #ef4444; }
    button.btn-blue { background: #0284c7; border-color: #38bdf8; }
    main {
      display: grid;
      grid-template-columns: 1fr 340px;
      gap: 16px;
      padding: 16px 20px;
    }
    @media (max-width: 980px) { main { grid-template-columns: 1fr; } }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
    }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 10px;
    }
    .screen-wrap {
      position: relative;
      background: #020617;
      border: 1px solid #1e293b;
      border-radius: 8px;
      overflow: hidden;
      min-height: 280px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    #screenImg {
      max-width: 100%;
      height: auto;
      display: block;
      cursor: crosshair;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      padding: 6px 0;
      border-bottom: 1px solid rgba(148,163,184,0.1);
    }
    .meta-row span:first-child { color: var(--muted); }
    input[type="text"] {
      width: 100%;
      background: #0f172a;
      border: 1px solid #334155;
      color: var(--text);
      padding: 8px 10px;
      border-radius: 8px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      margin-bottom: 8px;
    }
    .win-list { max-height: 200px; overflow-y: auto; font-size: 12px; }
    .win-item {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 6px;
      padding: 6px 8px;
      border-radius: 6px;
      background: #0f172a;
      margin-bottom: 6px;
    }
    .muted { color: var(--muted); font-size: 12px; }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <span>Handy Control Panel</span>
      <span class="muted">v${HANDY_VERSION}</span>
      <span id="permBadge" class="badge on">Checking...</span>
    </div>
    <div class="controls">
      <button class="btn-green" onclick="setPerm(true, 'full')">ON (Full Control)</button>
      <button class="btn-amber" onclick="setPerm(true, 'view_only')">View Only</button>
      <button onclick="setPerm(true, 'full', 900000)">ON 15m</button>
      <button class="btn-red" onclick="setPerm(false)">STOP / OFF</button>
    </div>
  </header>

  <main>
    <section class="card">
      <div class="toolbar">
        <div>
          <button class="btn-blue" onclick="refreshScreen()">Refresh Screen</button>
          <label style="margin-left:10px;font-size:13px;cursor:pointer;">
            <input type="checkbox" id="liveToggle" onchange="toggleLive()" /> Live (1.5s)
          </label>
          <label style="margin-left:10px;font-size:13px;cursor:pointer;">
            <input type="checkbox" id="diffToggle" checked onchange="refreshScreen()" /> Highlight Diff
          </label>
          <label style="margin-left:10px;font-size:13px;cursor:pointer;" title="Detect and number interactive UI elements; clicking one inserts a mark reference instead of raw coordinates">
            <input type="checkbox" id="marksToggle" onchange="refreshScreen()" /> Detect Marks
          </label>
        </div>
        <div class="muted" id="hoverCoords">Hover image to inspect (x, y)</div>
      </div>
      <div class="screen-wrap">
        <img id="screenImg" alt="Live annotated screen" style="display:none" />
        <div id="screenPlaceholder" class="muted">Click "Refresh Screen" to capture coordinate-mapped view</div>
      </div>
    </section>

    <aside style="display:flex;flex-direction:column;gap:14px;">
      <div class="card">
        <div style="font-weight:700;margin-bottom:8px;">Telemetry</div>
        <div class="meta-row"><span>Backend</span><span id="mBackend">-</span></div>
        <div class="meta-row"><span>Mouse</span><span id="mMouse">-</span></div>
        <div class="meta-row"><span>Pixel Hex</span><span id="mPixel">-</span></div>
        <div class="meta-row"><span>Active Window</span><span id="mWin">-</span></div>
        <div class="meta-row"><span>Frame Diff</span><span id="mDiff">-</span></div>
        <div class="meta-row"><span>UI Elements</span><span id="mMarks">-</span></div>
        <div class="meta-row"><span>Capture Latency</span><span id="mLatency">-</span></div>
      </div>

      <div class="card" id="marksCard" style="display:none;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-weight:700;">Detected Marks</span>
          <span class="muted" style="font-size:11px;">click to chain</span>
        </div>
        <div id="markList" class="win-list"></div>
      </div>

      <div class="card">
        <div style="font-weight:700;margin-bottom:8px;">Run Chained Action</div>
        <input id="chainInput" type="text" placeholder='move 420 260 -> click -> paste "Hello"' />
        <button class="btn-blue" style="width:100%" onclick="runChain()">Execute Chain</button>
        <div id="chainResult" class="muted" style="margin-top:8px;"></div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
          <span style="font-weight:700;">Windows</span>
          <button style="padding:4px 8px;font-size:11px;" onclick="loadWindows()">Refresh</button>
        </div>
        <div id="winList" class="win-list"><div class="muted">Click Refresh to list windows</div></div>
      </div>
    </aside>
  </main>

  <script>
    const TOKEN = ${JSON.stringify(token)};
    let screenMeta = null;
    let liveTimer = null;

    async function api(path, method = "GET", body) {
      const res = await fetch(path, {
        method,
        headers: {
          "x-handy-token": TOKEN,
          ...(body ? { "content-type": "application/json" } : {})
        },
        body: body ? JSON.stringify(body) : undefined
      });
      return res.json();
    }

    function updateBadge(state) {
      const el = document.getElementById("permBadge");
      if (!state.enabled) {
        el.className = "badge off";
        el.textContent = "OFF (Blocked)";
      } else if (state.mode === "view_only") {
        el.className = "badge view";
        el.textContent = "ON (View Only)";
      } else {
        el.className = "badge on";
        el.textContent = "ON (Full Control)";
      }
    }

    async function loadStatus() {
      const data = await api("/api/status");
      if (data.status) {
        updateBadge(data.status);
        document.getElementById("mBackend").textContent = data.status.backend || "-";
        if (data.status.mouse) {
          document.getElementById("mMouse").textContent = data.status.mouse.x + ", " + data.status.mouse.y;
        }
        if (data.status.activeWindow) {
          document.getElementById("mWin").textContent = data.status.activeWindow.title || "-";
        }
      }
    }

    async function setPerm(enabled, mode, durationMs) {
      const data = await api("/api/permission", "POST", { enabled, mode, durationMs });
      if (data.permission) updateBadge(data.permission);
      await loadStatus();
    }

    async function refreshScreen() {
      const hi = document.getElementById("diffToggle")?.checked ? "1" : "0";
      const mk = document.getElementById("marksToggle")?.checked ? "1" : "0";
      const data = await api("/api/see?highlightDiff=" + hi + "&marks=" + mk);
      if (!data.ok) {
        document.getElementById("screenPlaceholder").style.display = "block";
        document.getElementById("screenPlaceholder").textContent = data.error || "Unable to capture screen";
        document.getElementById("screenImg").style.display = "none";
        return;
      }
      screenMeta = data;
      const img = document.getElementById("screenImg");
      img.src = "data:image/png;base64," + data.base64Png;
      img.style.display = "block";
      document.getElementById("screenPlaceholder").style.display = "none";
      document.getElementById("mMouse").textContent = data.mouse.x + ", " + data.mouse.y;
      document.getElementById("mPixel").textContent = data.pixelUnderMouse || "-";
      document.getElementById("mWin").textContent = (data.activeWindow && data.activeWindow.title) || "-";
      document.getElementById("mDiff").textContent = data.screenDiff ? (data.screenDiff.changedPercent + "%") : "baseline";
      document.getElementById("mLatency").textContent = data.captureMs + " ms";
      renderMarks(data.elements);
    }

    function renderMarks(elements) {
      const card = document.getElementById("marksCard");
      const count = document.getElementById("mMarks");
      if (!elements || !elements.length) {
        card.style.display = "none";
        count.textContent = elements ? "0" : "-";
        return;
      }
      count.textContent = String(elements.length);
      card.style.display = "block";
      const list = document.getElementById("markList");
      list.innerHTML = "";
      for (const el of elements) {
        const row = document.createElement("div");
        row.className = "win-item";
        row.style.cursor = "pointer";
        row.title = "Bounds " + el.x + "," + el.y + " " + el.width + "x" + el.height + " — score " + el.score.toFixed(2);
        row.textContent = "#" + el.index + " " + el.kind + " (" + el.centerX + "," + el.centerY + ")";
        row.onclick = () => appendChain("click mark " + el.index);
        list.appendChild(row);
      }
    }

    function appendChain(fragment) {
      const inp = document.getElementById("chainInput");
      inp.value = inp.value ? (inp.value + " -> " + fragment) : fragment;
      inp.focus();
    }

    // Smallest detected element containing the point, so nested controls resolve to the tightest target.
    function markAt(elements, sx, sy) {
      if (!elements) return null;
      let best = null;
      for (const el of elements) {
        if (sx < el.x || sy < el.y || sx > el.x + el.width || sy > el.y + el.height) continue;
        const area = el.width * el.height;
        if (!best || area < best.area) best = { index: el.index, kind: el.kind, area };
      }
      return best;
    }

    function toggleLive() {
      const on = document.getElementById("liveToggle").checked;
      if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
      if (on) {
        refreshScreen();
        liveTimer = setInterval(refreshScreen, 1500);
      }
    }

    document.getElementById("screenImg").addEventListener("mousemove", (ev) => {
      if (!screenMeta) return;
      const rect = ev.target.getBoundingClientRect();
      const rx = (ev.clientX - rect.left) / Math.max(1, rect.width);
      const ry = (ev.clientY - rect.top) / Math.max(1, rect.height);
      const sx = Math.round(screenMeta.region.x + rx * screenMeta.region.width);
      const sy = Math.round(screenMeta.region.y + ry * screenMeta.region.height);
      const hit = markAt(screenMeta.elements, sx, sy);
      document.getElementById("hoverCoords").textContent = hit
        ? "Screen (" + sx + ", " + sy + ") — mark #" + hit.index + " (" + hit.kind + ") — click to chain"
        : "Screen (" + sx + ", " + sy + ") — click to insert into chain";
    });

    document.getElementById("screenImg").addEventListener("click", (ev) => {
      if (!screenMeta) return;
      const rect = ev.target.getBoundingClientRect();
      const rx = (ev.clientX - rect.left) / Math.max(1, rect.width);
      const ry = (ev.clientY - rect.top) / Math.max(1, rect.height);
      const sx = Math.round(screenMeta.region.x + rx * screenMeta.region.width);
      const sy = Math.round(screenMeta.region.y + ry * screenMeta.region.height);
      const hit = markAt(screenMeta.elements, sx, sy);
      appendChain(hit ? ("click mark " + hit.index) : ("click " + sx + " " + sy));
    });

    async function runChain() {
      const expr = document.getElementById("chainInput").value.trim();
      if (!expr) return;
      const out = document.getElementById("chainResult");
      out.textContent = "Running...";
      const data = await api("/api/act", "POST", { chain: expr });
      if (data.ok) {
        out.textContent = "Completed " + data.stepsCompleted + " step(s) in " + data.totalDurationMs + " ms";
        await refreshScreen();
      } else {
        out.textContent = "Error: " + (data.error || "failed");
      }
    }

    async function loadWindows() {
      const data = await api("/api/windows");
      const container = document.getElementById("winList");
      container.innerHTML = "";
      if (!data.ok || !data.windows || data.windows.length === 0) {
        container.innerHTML = '<div class="muted">No windows reported</div>';
        return;
      }
      for (const w of data.windows) {
        const row = document.createElement("div");
        row.className = "win-item";
        const label = document.createElement("span");
        label.textContent = (w.focused ? "● " : "") + w.title;
        const btn = document.createElement("button");
        btn.style.padding = "3px 8px";
        btn.style.fontSize = "11px";
        btn.textContent = "Focus";
        btn.onclick = async () => {
          await api("/api/windows/focus", "POST", { id: w.id, title: w.title });
          await loadWindows();
          await refreshScreen();
        };
        row.appendChild(label);
        row.appendChild(btn);
        container.appendChild(row);
      }
    }

    if (typeof EventSource !== "undefined") {
      const es = new EventSource("/api/events?token=" + encodeURIComponent(TOKEN));
      es.addEventListener("permission", (ev) => {
        try {
          const state = JSON.parse(ev.data);
          updateBadge(state);
        } catch {}
      });
    }

    loadStatus();
    refreshScreen();
  </script>
</body>
</html>`;
}
export async function startControlPanel(options = {}) {
    const host = options.host ?? "127.0.0.1";
    const port = options.port ?? 7788;
    const permissions = options.permissions ?? new PermissionStore();
    const controller = options.controller ??
        new HandyController({
            backend: createBackend({ kind: options.backendKind }),
            permissions,
        });
    const token = randomBytes(24).toString("hex");
    const html = renderHtml(token);
    const sseClients = new Set();
    const stopPermWatch = controller.permissions.watch((state) => {
        const payload = `event: permission\ndata: ${JSON.stringify(state)}\n\n`;
        for (const client of sseClients) {
            if (!client.writableEnded) {
                client.write(payload);
            }
        }
    });
    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
            if (req.method === "GET" && url.pathname === "/") {
                res.writeHead(200, {
                    "content-type": "text/html; charset=utf-8",
                    "cache-control": "no-store",
                    "x-frame-options": "SAMEORIGIN",
                });
                res.end(html);
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/events") {
                const providedToken = req.headers["x-handy-token"] ?? url.searchParams.get("token");
                if (providedToken !== token) {
                    sendJson(res, 403, { ok: false, error: "Forbidden: missing or invalid token." });
                    return;
                }
                res.writeHead(200, {
                    "content-type": "text/event-stream; charset=utf-8",
                    "cache-control": "no-cache, no-store",
                    connection: "keep-alive",
                });
                const initial = controller.permissions.getState();
                res.write(`event: permission\ndata: ${JSON.stringify(initial)}\n\n`);
                sseClients.add(res);
                req.on("close", () => {
                    sseClients.delete(res);
                });
                return;
            }
            if (url.pathname.startsWith("/api/")) {
                const headerToken = req.headers["x-handy-token"];
                if (headerToken !== token) {
                    sendJson(res, 403, { ok: false, error: "Forbidden: missing or invalid X-Handy-Token." });
                    return;
                }
            }
            if (req.method === "GET" && url.pathname === "/api/status") {
                const status = await controller.status();
                sendJson(res, 200, { ok: true, status });
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/permission") {
                const body = await readJsonBody(req);
                const enabled = Boolean(body.enabled);
                if (!enabled) {
                    await controller.releaseHeldInputs();
                }
                const permission = controller.permissions.setEnabled(enabled, {
                    mode: body.mode === "view_only" ? "view_only" : "full",
                    ttlMs: typeof body.durationMs === "number" ? body.durationMs : undefined,
                    updatedBy: "ui",
                });
                sendJson(res, 200, { ok: true, permission });
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/see") {
                const highlightDiff = url.searchParams.get("highlightDiff") === "1";
                const marks = url.searchParams.get("marks") === "1";
                const windowQuery = url.searchParams.get("window") ?? undefined;
                const shot = await controller.see({
                    grid: true,
                    showMouse: true,
                    highlightDiff,
                    marks,
                    window: windowQuery || undefined,
                });
                sendJson(res, 200, {
                    ok: true,
                    base64Png: shot.base64Png,
                    mouse: shot.mouse,
                    pixelUnderMouse: shot.pixelUnderMouse,
                    activeWindow: shot.activeWindow,
                    screenDiff: shot.screenDiff,
                    region: shot.region,
                    captureMs: shot.captureMs,
                    elements: shot.elements ?? null,
                });
                return;
            }
            if (req.method === "GET" && url.pathname === "/api/windows") {
                const windows = await controller.listWindows();
                sendJson(res, 200, { ok: true, windows });
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/windows/focus") {
                const body = await readJsonBody(req);
                const result = await controller.focusWindow({
                    id: typeof body.id === "string" || typeof body.id === "number" ? body.id : undefined,
                    title: typeof body.title === "string" ? body.title : undefined,
                    app: typeof body.app === "string" ? body.app : undefined,
                });
                sendJson(res, 200, { ok: result.focused, ...result });
                return;
            }
            if (req.method === "POST" && url.pathname === "/api/act") {
                const body = await readJsonBody(req);
                const chainStr = typeof body.chain === "string" ? body.chain : "";
                const steps = parseChainInput(chainStr);
                const result = await controller.act({ actions: steps });
                sendJson(res, 200, {
                    ok: true,
                    stepsCompleted: result.stepsCompleted,
                    totalDurationMs: result.totalDurationMs,
                    mouse: result.mouse,
                    receipts: result.receipts,
                });
                return;
            }
            sendJson(res, 404, { ok: false, error: "Not found" });
        }
        catch (err) {
            sendJson(res, 400, {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    });
    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
            server.off("error", reject);
            resolve();
        });
    });
    const addr = server.address();
    const displayHost = host === "0.0.0.0" ? "127.0.0.1" : host;
    const url = `http://${displayHost}:${addr.port}`;
    return {
        url,
        port: addr.port,
        host,
        token,
        controller,
        server,
        close: async () => {
            stopPermWatch();
            for (const client of sseClients) {
                if (!client.writableEnded) {
                    client.end();
                }
            }
            sseClients.clear();
            await new Promise((resolve) => server.close(() => resolve()));
            await controller.close();
        },
    };
}
