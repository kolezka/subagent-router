// Task: local operator console served by a sibling module at GET / on 127.0.0.1.
// The whole document is a plain template literal: no ${ substitutions, so no escaping
// hazards. Every DOM write in the inline script uses createElement/textContent only,
// per the CSP (script-src 'unsafe-inline', connect-src 'self', no markup-injection sinks).

export const UI_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>subagent-router</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #14161a;
    --panel: #1c1f26;
    --panel-2: #22262f;
    --border: #333846;
    --text: #d9dce3;
    --muted: #8b91a0;
    --accent: #5aa9ff;
    --red: #ff6b6b;
    --amber: #e0a83b;
    --green: #5bd68f;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 10px 16px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    flex-wrap: wrap;
  }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; letter-spacing: 0.02em; }
  header .meta { color: var(--muted); font-size: 12px; display: flex; gap: 14px; flex-wrap: wrap; }
  header .spacer { flex: 1; }
  button {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 12px;
    font-size: 13px;
    cursor: pointer;
  }
  button:hover { border-color: var(--accent); }
  nav.tabs {
    display: flex;
    gap: 2px;
    padding: 0 16px;
    background: var(--panel);
    border-bottom: 1px solid var(--border);
    overflow-x: auto;
  }
  nav.tabs button {
    background: transparent;
    border: none;
    border-bottom: 2px solid transparent;
    border-radius: 0;
    padding: 10px 14px;
    color: var(--muted);
  }
  nav.tabs button.active { color: var(--text); border-bottom-color: var(--accent); }
  main { padding: 16px; max-width: 1200px; margin: 0 auto; }
  .view { display: none; }
  .view.active { display: block; }
  .panel {
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 12px 14px;
    margin-bottom: 14px;
  }
  .panel h2 {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--muted);
    margin: 0 0 10px 0;
  }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  tr:last-child td { border-bottom: none; }
  .kv-row { display: flex; gap: 8px; padding: 4px 0; }
  .kv-row .k { color: var(--muted); width: 180px; flex-shrink: 0; }
  .badge {
    display: inline-block;
    padding: 1px 7px;
    border-radius: 10px;
    font-size: 11px;
    border: 1px solid var(--border);
    margin-right: 4px;
  }
  .badge.ok { color: var(--green); border-color: var(--green); }
  .badge.warn { color: var(--amber); border-color: var(--amber); }
  .badge.bad { color: var(--red); border-color: var(--red); }
  .badge.neutral { color: var(--muted); }
  ul.problem-list { margin: 0; padding-left: 18px; }
  ul.problem-list.problems li { color: var(--red); }
  ul.problem-list.warnings li { color: var(--amber); }
  .empty { color: var(--muted); font-style: italic; padding: 6px 0; }
  .loading { color: var(--muted); padding: 6px 0; }
  .error-box {
    border: 1px solid var(--red);
    border-radius: 4px;
    padding: 8px 10px;
    color: var(--red);
    font-size: 13px;
  }
  .error-box .code { font-weight: 600; margin-right: 6px; }
  input[type="text"], select {
    background: var(--panel-2);
    color: var(--text);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 6px 8px;
    font-size: 13px;
  }
  form.route-form { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end; margin-bottom: 10px; }
  form.route-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); }
  .filter-box { margin-bottom: 10px; }
  .note { color: var(--muted); font-size: 12px; margin-top: 8px; }
  pre {
    background: var(--panel-2);
    border: 1px solid var(--border);
    border-radius: 4px;
    padding: 10px;
    overflow: auto;
    font-size: 12px;
    max-height: 70vh;
  }
</style>
</head>
<body>
<header>
  <h1>subagent-router</h1>
  <div class="meta">
    <span id="header-generation">generation: loading...</span>
    <span id="header-config-path"></span>
  </div>
  <span class="spacer"></span>
  <button id="refresh-btn" type="button">Refresh</button>
</header>
<nav class="tabs">
  <button type="button" class="tab-btn active" data-view="overview">Overview</button>
  <button type="button" class="tab-btn" data-view="models">Models</button>
  <button type="button" class="tab-btn" data-view="agents">Agents</button>
  <button type="button" class="tab-btn" data-view="route">Route preview</button>
  <button type="button" class="tab-btn" data-view="config">Config</button>
</nav>
<main>
  <div class="view active" id="view-overview"></div>
  <div class="view" id="view-models"></div>
  <div class="view" id="view-agents"></div>
  <div class="view" id="view-route"></div>
  <div class="view" id="view-config"></div>
</main>
<script>
(function () {
  "use strict";

  // ---- DOM helpers. No markup-injecting sinks or eval anywhere in this script. ----

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    for (var key in attrs || {}) {
      if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
      if (key === "text") node.textContent = attrs[key];
      else if (key === "className") node.className = attrs[key];
      else node.setAttribute(key, attrs[key]);
    }
    (children || []).forEach(function (c) { node.appendChild(c); });
    return node;
  }

  function text(str) { return document.createTextNode(str); }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function loadingNode() { return el("div", { className: "loading", text: "Loading..." }); }

  function errorNode(err) {
    var box = el("div", { className: "error-box" });
    box.appendChild(el("span", { className: "code", text: (err && err.code) ? String(err.code) : "error" }));
    box.appendChild(text((err && err.message) ? err.message : "Request failed."));
    return box;
  }

  function emptyNode(label) { return el("div", { className: "empty", text: label }); }

  function badge(kind, label) { return el("span", { className: "badge " + kind, text: label }); }

  function boolBadge(value, trueLabel, falseLabel) {
    return value ? badge("warn", trueLabel) : badge("neutral", falseLabel);
  }

  function panel(title) {
    var p = el("div", { className: "panel" });
    if (title) p.appendChild(el("h2", { text: title }));
    return p;
  }

  // value: string | Node | Node[]
  function kv(label, value) {
    var row = el("div", { className: "kv-row" });
    row.appendChild(el("span", { className: "k", text: label }));
    if (typeof value === "string") row.appendChild(text(value));
    else if (Array.isArray(value)) value.forEach(function (n) { row.appendChild(n); });
    else row.appendChild(value);
    return row;
  }

  // rows: array of arrays; each cell is a string, a Node, or an array of Nodes.
  function makeTable(headers, rows) {
    var table = el("table");
    table.appendChild(el("thead", null, [el("tr", null, headers.map(function (h) { return el("th", { text: h }); }))]));
    var tbody = el("tbody");
    rows.forEach(function (row) {
      var tr = el("tr");
      row.forEach(function (cell) {
        var td = el("td");
        if (typeof cell === "string") td.textContent = cell;
        else if (Array.isArray(cell)) cell.forEach(function (n) { td.appendChild(n); });
        else td.appendChild(cell);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }

  function problemList(label, items, cssClass) {
    var wrap = el("div");
    wrap.appendChild(el("div", { className: "kv-row" }, [el("span", { className: "k", text: label })]));
    if (!items || items.length === 0) {
      wrap.appendChild(emptyNode("no " + label.toLowerCase() + " found"));
      return wrap;
    }
    var list = el("ul", { className: "problem-list " + cssClass });
    items.forEach(function (item) { list.appendChild(el("li", { text: item })); });
    wrap.appendChild(list);
    return wrap;
  }

  function selectField(labelText, options) {
    var select = el("select");
    options.forEach(function (o) { select.appendChild(el("option", { value: o, text: o })); });
    var label = el("label", null, [text(labelText), select]);
    return { label: label, select: select };
  }

  function textField(labelText, required) {
    var attrs = { type: "text" };
    if (required) attrs.required = "required";
    var input = el("input", attrs);
    var label = el("label", null, [text(labelText), input]);
    return { label: label, input: input };
  }

  // Every fetch stays same-origin and relative; query strings go through URLSearchParams.
  function apiGet(path, params) {
    var url = path;
    if (params) {
      var qs = new URLSearchParams();
      for (var key in params) {
        if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
        if (params[key]) qs.set(key, params[key]);
      }
      var qsString = qs.toString();
      if (qsString) url = path + "?" + qsString;
    }
    return fetch(url, { headers: { accept: "application/json" } }).then(function (res) {
      return res.json().then(function (body) { return { ok: res.ok, body: body }; });
    });
  }

  // ---- Views ----

  function refreshHeader() {
    apiGet("/api/status", null).then(function (result) {
      var genEl = document.getElementById("header-generation");
      var pathEl = document.getElementById("header-config-path");
      if (!result.ok) {
        genEl.textContent = "generation: unavailable";
        pathEl.textContent = "";
        return;
      }
      var payload = result.body.payload;
      genEl.textContent = "generation: " + payload.generation;
      pathEl.textContent = "config: " + payload.configPath;
    });
  }

  function renderOverview() {
    var root = document.getElementById("view-overview");
    clear(root);
    root.appendChild(loadingNode());

    Promise.all([apiGet("/api/doctor", null), apiGet("/api/config/check", null)]).then(function (results) {
      var doctorResult = results[0];
      var checkResult = results[1];
      clear(root);
      if (!doctorResult.ok) { root.appendChild(errorNode(doctorResult.body.error)); return; }
      var doctor = doctorResult.body.payload;

      var configPanel = panel("Config");
      configPanel.appendChild(kv("status", doctor.config.ok ? badge("ok", "ok") : badge("bad", "problem")));
      configPanel.appendChild(doctor.config.ok ? kv("generation", doctor.config.generation) : kv("error", doctor.config.error));
      configPanel.appendChild(kv("snapshot stale", boolBadge(doctor.snapshotStale, "stale", "fresh")));
      root.appendChild(configPanel);

      var clientsPanel = panel("Clients");
      if (doctor.clients.length === 0) {
        clientsPanel.appendChild(emptyNode("No clients reported."));
      } else {
        var clientRows = doctor.clients.map(function (c) {
          return [c.client, c.version, c.status, (c.diagnostics || []).join("; ")];
        });
        clientsPanel.appendChild(makeTable(["client", "version", "status", "diagnostics"], clientRows));
      }
      root.appendChild(clientsPanel);

      var transportPanel = panel("Transport");
      var t = doctor.transport;
      transportPanel.appendChild(kv("adapter", t.adapterId));
      transportPanel.appendChild(kv("runtime version", t.runtimeVersion));
      transportPanel.appendChild(kv("status", t.status));
      root.appendChild(transportPanel);

      var checkPanel = panel("Config check");
      if (checkResult.ok) {
        var check = checkResult.body.payload;
        checkPanel.appendChild(problemList("Problems", check.problems, "problems"));
        checkPanel.appendChild(problemList("Warnings", check.warnings, "warnings"));
      } else {
        checkPanel.appendChild(errorNode(checkResult.body.error));
      }
      root.appendChild(checkPanel);
    });
  }

  function renderModels() {
    var root = document.getElementById("view-models");
    clear(root);
    root.appendChild(loadingNode());

    apiGet("/api/models", null).then(function (result) {
      clear(root);
      if (!result.ok) { root.appendChild(errorNode(result.body.error)); return; }
      var payload = result.body.payload;

      var top = panel();
      top.appendChild(kv("fetched at", payload.fetchedAt ? payload.fetchedAt : "never"));
      var filterInput = el("input", { type: "text", placeholder: "Filter by id, alias or description" });
      top.appendChild(el("div", { className: "filter-box" }, [filterInput]));
      var tableHolder = el("div");
      top.appendChild(tableHolder);
      root.appendChild(top);

      function draw(filterValue) {
        clear(tableHolder);
        var needle = filterValue.trim().toLowerCase();
        var rows = payload.models.filter(function (m) {
          if (!needle) return true;
          return (m.id + " " + m.alias + " " + (m.description || "")).toLowerCase().indexOf(needle) !== -1;
        });
        if (payload.models.length === 0) { tableHolder.appendChild(emptyNode("No models configured.")); return; }
        if (rows.length === 0) { tableHolder.appendChild(emptyNode("No models match the filter.")); return; }
        var tableRows = rows.map(function (m) {
          return [m.id, m.alias, m.status, m.enabled ? "yes" : "no", m.description || ""];
        });
        tableHolder.appendChild(makeTable(["id", "alias", "status", "enabled", "description"], tableRows));
      }

      filterInput.addEventListener("input", function () { draw(filterInput.value); });
      draw("");
    });
  }

  function renderAgents() {
    var root = document.getElementById("view-agents");
    clear(root);

    var picker = selectField("Client ", ["claude-code", "opencode", "codex"]);
    var controlsPanel = panel();
    controlsPanel.appendChild(picker.label);
    root.appendChild(controlsPanel);

    var resultHolder = el("div");
    root.appendChild(resultHolder);

    function loadFor(client) {
      clear(resultHolder);
      resultHolder.appendChild(loadingNode());
      apiGet("/api/agents", { client: client }).then(function (result) {
        clear(resultHolder);
        if (!result.ok) { resultHolder.appendChild(errorNode(result.body.error)); return; }
        var payload = result.body.payload;

        var metaPanel = panel();
        metaPanel.appendChild(kv("completeness", payload.completeness));
        if (payload.diagnostics && payload.diagnostics.length > 0) {
          metaPanel.appendChild(problemList("Diagnostics", payload.diagnostics, "warnings"));
        }
        resultHolder.appendChild(metaPanel);

        var tablePanel = panel();
        if (payload.agents.length === 0) {
          tablePanel.appendChild(emptyNode("No agents found for this client."));
        } else {
          var rows = payload.agents.map(function (a) {
            var flags = [];
            if (a.shadowed) flags.push(badge("warn", "shadowed"));
            if (a.hidden) flags.push(badge("neutral", "hidden"));
            return [a.name, a.scope, a.declaredModel, a.availability, flags];
          });
          tablePanel.appendChild(makeTable(["name", "scope", "declared model", "availability", "flags"], rows));
        }
        resultHolder.appendChild(tablePanel);
      });
    }

    picker.select.addEventListener("change", function () { loadFor(picker.select.value); });
    loadFor(picker.select.value);
  }

  function renderRoute() {
    var root = document.getElementById("view-route");
    clear(root);

    var clientField = selectField("Client", ["claude-code", "opencode", "codex"]);
    var agentField = textField("Agent (required)", true);
    var modelField = textField("Model (optional)", false);
    var parentModelField = textField("Parent model (optional)", false);
    var submitBtn = el("button", { type: "submit", text: "Preview" });

    var form = el("form", { className: "route-form" }, [
      clientField.label, agentField.label, modelField.label, parentModelField.label, submitBtn
    ]);
    root.appendChild(el("div", { className: "panel" }, [form]));

    var resultHolder = el("div");
    root.appendChild(resultHolder);

    form.addEventListener("submit", function (event) {
      event.preventDefault();
      var agentValue = agentField.input.value.trim();
      if (!agentValue) return;

      clear(resultHolder);
      resultHolder.appendChild(loadingNode());

      apiGet("/api/route/preview", {
        client: clientField.select.value,
        agent: agentValue,
        model: modelField.input.value.trim(),
        "parent-model": parentModelField.input.value.trim()
      }).then(function (result) {
        clear(resultHolder);
        if (!result.ok) { resultHolder.appendChild(errorNode(result.body.error)); return; }
        var payload = result.body.payload;
        var decision = payload.decision;

        var p = panel();
        p.appendChild(kv("agent", payload.agent.name + " (scope: " + payload.agent.scope + ", declared: " + payload.agent.declaredModel + ")"));
        p.appendChild(kv("decision", badge(decision.kind === "error" ? "bad" : "ok", decision.kind)));

        if (decision.kind === "route") {
          p.appendChild(kv("upstream model", decision.upstreamModel));
          if (decision.clientModel) p.appendChild(kv("client model", decision.clientModel));
          p.appendChild(kv("source", decision.source));
        } else if (decision.kind === "error") {
          p.appendChild(kv("code", decision.code));
        } else if (decision.kind === "pass-through") {
          p.appendChild(kv("reason", decision.reason));
        }

        p.appendChild(kv("ignored markers", String(decision.ignoredMarkers)));

        var a = payload.assumptions;
        var note = "Simulation only. authenticatedChild=" + a.authenticatedChild +
          ", freshDelegation=" + a.freshDelegation +
          ", runtimeCapabilityNotProven=" + a.runtimeCapabilityNotProven;
        p.appendChild(el("div", { className: "note", text: note }));

        resultHolder.appendChild(p);
      });
    });
  }

  function renderConfig() {
    var root = document.getElementById("view-config");
    clear(root);
    root.appendChild(loadingNode());

    apiGet("/api/config/show", null).then(function (result) {
      clear(root);
      if (!result.ok) { root.appendChild(errorNode(result.body.error)); return; }
      var payload = result.body.payload;
      var p = panel();
      p.appendChild(kv("generation", payload.generation));
      p.appendChild(el("pre", null, [text(JSON.stringify(payload.config, null, 2))]));
      root.appendChild(p);
    });
  }

  var renderers = { overview: renderOverview, models: renderModels, agents: renderAgents, route: renderRoute, config: renderConfig };
  var activeView = "overview";

  function activate(viewName) {
    activeView = viewName;
    document.querySelectorAll(".tab-btn").forEach(function (btn) {
      btn.classList.toggle("active", btn.getAttribute("data-view") === viewName);
    });
    document.querySelectorAll(".view").forEach(function (v) {
      v.classList.toggle("active", v.id === "view-" + viewName);
    });
    renderers[viewName]();
  }

  document.querySelectorAll(".tab-btn").forEach(function (btn) {
    btn.addEventListener("click", function (event) {
      activate(event.currentTarget.getAttribute("data-view"));
    });
  });

  document.getElementById("refresh-btn").addEventListener("click", function () {
    refreshHeader();
    renderers[activeView]();
  });

  refreshHeader();
  renderOverview();
})();
</script>
</body>
</html>
`;
