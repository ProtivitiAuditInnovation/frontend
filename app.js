(() => {
  "use strict";
  const API = ((window.UAR_CONFIG && window.UAR_CONFIG.API_BASE) || "http://localhost:8000/api").replace(/\/+$/, "");
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // ------------------------------------------------------------------ evidence slots (generic names)
  const SLOTS = [
    { key: "start_listing", ref: "E1", title: "Start-of-review user listing", fmt: "Excel", accept: ".xlsx,.xlsm",
      purpose: "Population tested and completeness of the review file", required: true },
    { key: "start_listing_pdf", ref: "E2", title: "Start-of-review user listing", fmt: "PDF or system report", accept: ".pdf",
      purpose: "Report extraction (IPE): row count and report timestamp" },
    { key: "review_file", ref: "E3", title: "Manager review file", fmt: "Excel with manager and decision columns",
      accept: ".xlsx,.xlsm", purpose: "Approve or reject decision for each access row", required: true },
    { key: "approvals", ref: "E4", title: "Manager approval e-mails", fmt: ".msg, .eml, or a .zip of them (full trails)",
      accept: ".msg,.eml,.zip", multiple: true, recommended: true,
      purpose: "The list sent to each manager, request and reply dates, and what each manager decided" },
    { key: "post_listing", ref: "E5", title: "Post-review user listing", fmt: "Excel", accept: ".xlsx,.xlsm",
      purpose: "Confirms rejected access was removed", required: true },
    { key: "post_listing_pdf", ref: "E6", title: "Post-review user listing", fmt: "PDF or system report", accept: ".pdf",
      purpose: "Report extraction (IPE) for the post-review listing" },
    { key: "removed_accounts", ref: "E7", title: "Removed accounts analysis", fmt: "Excel prepared by the client",
      accept: ".xlsx,.xlsm", purpose: "Reconciles the client's own list of removals" },
    { key: "extraction_steps", ref: "E8", title: "Report extraction steps", fmt: "Word, PDF or text",
      accept: ".docx,.doc,.pdf,.txt", purpose: "Kept with the run as IPE evidence" },
  ];
  const files = Object.fromEntries(SLOTS.map((s) => [s.key, []]));
  const rowErrors = {};
  let aiEnabled = false, currentRun = null, pollTimer = null, results = null, chatHistory = [];
  const tableState = { tab: "exceptions", page: 0, filter: "" };
  const PAGE = 50;

  // ------------------------------------------------------------------ API helper
  async function api(path, opts = {}) {
    let r;
    try { r = await fetch(API + path, opts); }
    catch (e) { throw new Error(`Cannot reach the backend at ${API}. Check that it is running and that config.js points to it.`); }
    let body = null;
    try { body = await r.json(); } catch (e) { /* non-JSON */ }
    if (!r.ok) {
      let msg = body && body.detail;
      if (Array.isArray(msg)) msg = msg.map((d) => `${(d.loc || []).slice(-1)[0] || ""} ${d.msg}`.trim()).join("; ");
      throw new Error(msg || `Request failed (${r.status})`);
    }
    return body;
  }

  // ------------------------------------------------------------------ brand + health
  const logo = $("#brandLogo");
  logo.addEventListener("error", () => { logo.hidden = true; $("#brandText").hidden = false; });
  if (logo.complete && logo.naturalWidth === 0) { logo.hidden = true; $("#brandText").hidden = false; }

  async function checkHealth() {
    const pill = $("#aiPill");
    try {
      const h = await api("/health");
      aiEnabled = !!(h.ai && h.ai.enabled);
      pill.className = "pill " + (aiEnabled ? "pill-ok" : "pill-muted");
      pill.textContent = aiEnabled ? `AI on (${h.ai.deployment})` : "AI off: keyword rules";
      $("#retention").textContent = h.retention_days;
      const useAi = $("#useAi");
      useAi.disabled = !aiEnabled;
      if (!aiEnabled) { useAi.checked = false; $("#useAiNote").textContent = "Azure OpenAI is not configured on the backend, so e-mails are read with keyword rules."; }
      loadRuns();
    } catch (e) {
      pill.className = "pill pill-bad";
      pill.textContent = "Backend not reachable";
      pill.title = e.message;
    }
  }

  async function loadRuns() {
    try {
      const runs = await api("/runs");
      const sel = $("#runsSelect");
      sel.innerHTML = '<option value="">Previous runs</option>' + runs.map((r) =>
        `<option value="${esc(r.run_id)}">${esc(r.app_name || "Run")}, ${esc(fmtCreated(r.created))} (${esc(r.status)})</option>`).join("");
      if (currentRun) sel.value = currentRun;
    } catch (e) { /* the pill already shows connectivity problems */ }
  }
  const fmtCreated = (iso) => {
    if (!iso) return "";
    const [d, t] = iso.split("T");
    const [y, m, dd] = d.split("-");
    return `${m}-${dd}-${y} ${(t || "").slice(0, 5)}`;
  };

  // ------------------------------------------------------------------ evidence list
  function extOk(slot, name) {
    const ext = "." + name.split(".").pop().toLowerCase();
    return slot.accept.split(",").includes(ext);
  }

  function addFiles(slot, list) {
    const bad = [], good = [];
    for (const f of list) (extOk(slot, f.name) ? good : bad).push(f);
    rowErrors[slot.key] = bad.length ? `${bad.map((f) => f.name).join(", ")}: expected ${slot.accept.replaceAll(",", ", ")}` : "";
    if (good.length) {
      if (slot.multiple) {
        const names = new Set(files[slot.key].map((f) => f.name + f.size));
        files[slot.key].push(...good.filter((f) => !names.has(f.name + f.size)));
      } else files[slot.key] = [good[0]];
    }
    renderPBC();
  }

  function statusTag(slot) {
    if (files[slot.key].length) return '<span class="status-tag st-received">Received</span>';
    if (slot.required) return '<span class="status-tag st-required">Required</span>';
    if (slot.recommended) return '<span class="status-tag st-recommended">Recommended</span>';
    return '<span class="status-tag st-optional">Optional</span>';
  }

  function renderPBC() {
    const body = $("#pbcBody");
    body.innerHTML = SLOTS.map((s) => {
      const chips = files[s.key].map((f, i) =>
        `<span class="chip" title="${esc(f.name)}"><span>${esc(f.name)}</span>` +
        `<button type="button" data-remove="${s.key}" data-i="${i}" aria-label="Remove ${esc(f.name)}">×</button></span>`).join("");
      const label = files[s.key].length ? (s.multiple ? "Add more" : "Replace") : (s.multiple ? "Choose files" : "Choose file");
      return `<tr data-slot="${s.key}">
        <td class="ref">${s.ref}</td>
        <td class="item">${esc(s.title)}<small>${esc(s.fmt)}</small></td>
        <td class="purpose">${esc(s.purpose)}</td>
        <td class="file">${chips ? `<div class="chips">${chips}</div>` : ""}
          <label class="${files[s.key].length && !s.multiple ? "btn-quiet" : "btn btn-ghost"}">${label}
            <input type="file" class="visually-hidden" data-input="${s.key}" accept="${s.accept}" ${s.multiple ? "multiple" : ""}>
          </label>
          ${rowErrors[s.key] ? `<div class="row-error">${esc(rowErrors[s.key])}</div>` : ""}</td>
        <td class="status">${statusTag(s)}</td></tr>`;
    }).join("");
    updateReady();
  }

  $("#pbcBody").addEventListener("change", (e) => {
    const key = e.target.dataset.input;
    if (key) { addFiles(SLOTS.find((s) => s.key === key), e.target.files); }
  });
  $("#pbcBody").addEventListener("click", (e) => {
    const key = e.target.dataset.remove;
    if (key) { files[key].splice(+e.target.dataset.i, 1); rowErrors[key] = ""; renderPBC(); }
  });
  for (const ev of ["dragenter", "dragover"]) {
    $("#pbcBody").addEventListener(ev, (e) => {
      const tr = e.target.closest("tr[data-slot]");
      if (!tr) return;
      e.preventDefault();
      document.querySelectorAll(".pbc tr.drag").forEach((r) => r !== tr && r.classList.remove("drag"));
      tr.classList.add("drag");
    });
  }
  $("#pbcBody").addEventListener("dragleave", (e) => {
    const tr = e.target.closest("tr[data-slot]");
    if (tr && !tr.contains(e.relatedTarget)) tr.classList.remove("drag");
  });
  $("#pbcBody").addEventListener("drop", (e) => {
    const tr = e.target.closest("tr[data-slot]");
    if (!tr) return;
    e.preventDefault();
    tr.classList.remove("drag");
    addFiles(SLOTS.find((s) => s.key === tr.dataset.slot), e.dataTransfer.files);
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
  $("#clearFiles").addEventListener("click", () => { for (const k in files) files[k] = []; for (const k in rowErrors) rowErrors[k] = ""; renderPBC(); });

  function updateReady() {
    const req = SLOTS.filter((s) => s.required);
    const got = req.filter((s) => files[s.key].length).length;
    $("#pbcCount").textContent = `${got} of ${req.length} required items received`;
    const running = !!pollTimer;
    const ready = got === req.length && !running;
    $("#runBtn").disabled = !ready;
    const missing = req.filter((s) => !files[s.key].length).map((s) => s.ref);
    $("#runHint").textContent = running ? "Testing is running." :
      (missing.length ? `Add ${missing.join(", ")} to start.` :
        (files.approvals.length ? "Ready." : "Ready. Without approval e-mails every manager shows as no response."));
    setDone("evidence", got === req.length);
  }

  // ------------------------------------------------------------------ rail
  function setDone(step, on) { const li = document.querySelector(`#rail li[data-step="${step}"]`); if (li) li.classList.toggle("done", !!on); }
  const observer = new IntersectionObserver((entries) => {
    for (const en of entries) if (en.isIntersecting) {
      document.querySelectorAll("#rail li").forEach((li) => li.classList.toggle("current", li.dataset.step === en.target.id));
    }
  }, { rootMargin: "-30% 0px -60% 0px" });
  ["details", "evidence", "run", "results", "chat"].forEach((id) => observer.observe(document.getElementById(id)));
  const syncDetails = () => setDone("details", $("#appName").value.trim() && $("#controlOwner").value.trim());
  $("#details").addEventListener("input", syncDetails);

  // ------------------------------------------------------------------ run
  function options() {
    return {
      app_name: $("#appName").value.trim(), control_owner: $("#controlOwner").value.trim(),
      response_days: $("#responseDays").value, start_date: $("#startDate").value, after_date: $("#afterDate").value,
      dormant_days: $("#dormantDays").value, elevated_codes: $("#elevatedCodes").value,
      status_approve: $("#labelApprove").value.trim(), status_remove: $("#labelRemove").value.trim(),
      use_ai: $("#useAi").checked && aiEnabled,
    };
  }

  $("#runBtn").addEventListener("click", async () => {
    const fd = new FormData();
    for (const s of SLOTS) for (const f of files[s.key]) fd.append(s.key, f, f.name);
    fd.append("options", JSON.stringify(options()));
    $("#runBtn").disabled = true;
    showLog(["Uploading evidence ..."]);
    $("#progress").hidden = false;
    try {
      const r = await api("/runs", { method: "POST", body: fd });
      startPolling(r.run_id);
    } catch (e) {
      $("#progress").hidden = true;
      showLog([`Upload failed: ${e.message}`], true);
      updateReady();
    }
  });

  function showLog(lines, isErr) {
    const el = $("#runLog");
    el.hidden = false;
    el.innerHTML = lines.map((l) => (isErr || /^ERROR|\[WARN\]/.test(l.trim()) ?
      `<span class="err">${esc(l)}</span>` : esc(l))).join("\n");
    el.scrollTop = el.scrollHeight;
  }

  function startPolling(runId) {
    currentRun = runId;
    clearInterval(pollTimer);
    pollTimer = setInterval(() => poll(runId), 1500);
    updateReady();
    poll(runId);
  }

  async function poll(runId) {
    try {
      const j = await api(`/runs/${encodeURIComponent(runId)}`);
      showLog(j.log || []);
      if (j.status === "done" || j.status === "failed") {
        clearInterval(pollTimer); pollTimer = null;
        $("#progress").hidden = true;
        updateReady();
        loadRuns();
        if (j.status === "done") {
          setDone("run", true);
          renderResults(j);
          document.getElementById("results").scrollIntoView({ block: "start" });
        } else {
          showLog([...(j.log || []), "", `The run stopped: ${j.error || "unknown error"}.`,
            "Check that each file is in the right row and that the Excel files have a 'User code' header."], false);
        }
      }
    } catch (e) {
      clearInterval(pollTimer); pollTimer = null;
      $("#progress").hidden = true;
      showLog([`Lost contact with the backend: ${e.message}`], true);
      updateReady();
    }
  }

  // ------------------------------------------------------------------ results
  const val = (m) => { const s = (results.summary || []).find((x) => x.metric === m); return s ? s.value : null; };
  const num = (m) => Number(val(m)) || 0;
  const rows = (t) => (results.tables[t] ? results.tables[t].rows : []);
  const colIdx = (t, c) => results.tables[t].columns.indexOf(c);

  function renderResults(j) {
    results = j;
    $("#resultsEmpty").hidden = true;
    $("#resultsBody").hidden = false;
    setDone("results", true);

    const exc = num("Rows with exceptions"), total = num("Rows in review file");
    const mi = colIdx("managers", "Exception Rows");
    const mgrsWithExc = rows("managers").filter((r) => Number(r[mi]) > 0).length;
    const clean = exc === 0 && val("Conclusion") === "No exceptions noted";
    $("#conclusion").classList.toggle("is-bad", !clean);
    $("#conclusionTitle").textContent = clean ? "No exceptions noted" : "Exceptions noted";
    $("#conclusionSub").textContent = clean
      ? `All ${total} access rows agreed without exception.`
      : `${exc} of ${total} access rows need follow-up, across ${mgrsWithExc} of ${num("Managers in scope")} managers.` +
        (val("Row count agrees to PDF") !== "Yes" ? " The report row count also needs checking." : "");
    $("#downloadBtn").href = `${API}/runs/${encodeURIComponent(j.run_id)}/workbook`;
    const m = j.meta || {};
    $("#runMeta").textContent = `${m.app_name || ""}. Start listing ${m.start_date} (${m.start_date_source}). ` +
      `Post-review listing ${m.after_date} (${m.after_date_source}). Replies on time within ${m.response_days} days ` +
      `of each manager's request e-mail. E-mails read by: ${m.method}.`;

    renderMatrix();
    renderMetrics();
    renderTabs();
    enableChat(j.run_id);
  }

  function tick(kind) {
    const sym = { ok: "✓", bad: "✗", info: "◇" }[kind];
    const label = { ok: "Agreed without exception", bad: "Exception noted", info: "For follow-up" }[kind];
    return `<span class="tick ${kind}" role="img" aria-label="${label}">${sym}</span>`;
  }

  function renderMatrix() {
    const rc = val("Row count agrees to PDF"), dt = String(val("PDF 'Created on' date agrees to extraction date") || "");
    const xl = String(val("Excel report 'Created on' agrees to extraction date") || "");
    const okish = (x) => x === "Yes" || x.startsWith("n/a");
    const ipeKind = String(rc).startsWith("No") || dt.startsWith("No") || xl.startsWith("No") ? "bad"
      : (rc === "Yes" && okish(dt) && okish(xl) ? "ok" : "info");
    const missing = num("Rows missing from review file"), extra = num("Rows in review file not in User Report"), nomgr = num("Rows with no manager assigned");
    const win = (results.meta && results.meta.response_days) || 30;
    const late = num(`Responses after ${win} days`), noresp = num("No response"), mgrs = num("Managers in scope");
    const ontime = num(`Responses within ${win} days of the request`);
    const notSup = num("Rejections not supported by manager e-mail"), conflict = num("Approved rows the e-mail asked to remove");
    const notCovered = num("Approved rows not covered by the manager's reply");
    const reqMgrs = num("Managers with a request e-mail list"), reqMatch = num("Managers whose e-mailed rows match the start User Report");
    const notSentV = val("Start-report rows not e-mailed to any manager"), notSent = Number(notSentV) || 0;
    const mgrDiff = num("Rows whose review-file manager differs from the e-mail");
    const selfA = num("Self-approvals (user = manager)");
    const rejected = num("Rows rejected"), removed = num("Rejected rows removed in After Listing"), still = num("Rejected rows still present (exception)");
    const follow = [
      [num("Users removed outside the review (check)"), "user", "removed outside the review"],
      [num("Rows added after the review (new access)"), "access row", "added after the review"],
      [num("Dormant / never-logged-in rows approved"), "approved row", "dormant or never used"],
      [num("AI answers not verified against the e-mail (check)"), "AI answer", "not verified against the e-mail"],
      [num("Replies not sent by the manager themselves (check)"), "reply", "sent by someone other than the manager"],
      [num("Rows with no decision"), "row", "with no reviewer decision"],
    ].filter(([n]) => n > 0);
    const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

    const items = [
      [ipeKind, "Report extraction (IPE)", "Excel listing agrees to the system report; report date matches the extraction date",
        `PDF row count: ${rc === "Yes" ? "agrees" : rc}. Excel report date: ${xl === "Yes" ? "agrees" : xl}. ` +
        `PDF report date: ${dt === "Yes" ? "agrees" : dt}.`],
      [missing + extra + nomgr ? "bad" : "ok", "Completeness of the review", "Every access row in the start listing was sent for review, with a manager",
        missing + extra + nomgr ? `${plural(missing, "row")} missing from the review file, ${extra} extra, ${nomgr} without a manager.`
          : `All ${num("Access rows - start User Report (Excel)")} access rows were reviewed.`],
      [!reqMgrs ? "info" : (reqMatch < reqMgrs || notSent || mgrDiff ? "bad" : "ok"), "Population sent to managers",
        "The list pasted in each manager's request e-mail agrees, row by row, to the start listing",
        !reqMgrs ? "No pasted lists were found in the e-mails, so this was not tested." :
          `${reqMatch} of ${reqMgrs} managers' lists match; ${plural(notSent, "start-listing row")} not e-mailed to any manager; ` +
          `${plural(mgrDiff, "row")} e-mailed to a different manager than the review file.`],
      [late + noresp ? "bad" : "ok", "Timely manager responses", `Each manager replied within ${win} days of their request e-mail`,
        `${ontime} of ${mgrs} managers within ${win} days; ${late} after ${win} days; ${noresp} with no response.`],
      [notSup + conflict + notCovered ? "bad" : "ok", "Decisions match the e-mail",
        "Rejections and approvals in the review file match what the manager wrote",
        notSup + conflict + notCovered ? `${plural(notSup, "rejected row")} not named for removal; ` +
          `${plural(conflict, "approved row")} the e-mail asked to remove; ${plural(notCovered, "approved row")} not covered by the reply.`
          : "Every decision agrees to the manager's e-mail."],
      [selfA ? "bad" : "ok", "No self-approval", "No user approved their own access",
        selfA ? `${plural(selfA, "access row")} approved by the user themselves.` : "None found."],
      [still ? "bad" : "ok", "Rejected access removed", "Rejected access is absent from the post-review listing",
        rejected ? `${removed} of ${rejected} rejected rows removed; ${still} still present.` : "No access was rejected."],
      [follow.length ? "info" : "ok", "Items for follow-up", "Observations that need a reviewer's judgement",
        follow.length ? follow.map(([n, noun, rest]) => `${plural(n, noun)} ${rest}`).join("; ") + "." : "Nothing to follow up."],
    ];
    $("#matrix tbody").innerHTML = items.map(([k, a, w, r]) =>
      `<tr><td class="tick-cell">${tick(k)}</td><td class="attr">${esc(a)}</td><td class="what">${esc(w)}</td><td class="res">${esc(r)}</td></tr>`).join("");
  }

  function renderMetrics() {
    let html = "", sec = "";
    for (const s of results.summary) {
      if (s.section !== sec) { sec = s.section; html += `<tr class="sec"><td colspan="2">${esc(sec)}</td></tr>`; }
      html += `<tr><td>${esc(s.metric)}</td><td>${esc(s.value)}</td></tr>`;
    }
    $("#metricsTable tbody").innerHTML = html;
  }

  const TABS = [
    { id: "exceptions", label: "Exceptions", table: "uar", filter: (r, t) => r[t.columns.indexOf("Exception")] === "Yes",
      cols: ["User code", "User name", "Manager", "Code", "Status", "Exception Detail", "Request Sent", "Response Date",
             "Days to Respond", "@Responded within", "Email cross-check", "Comments", "Post Review Match", "Type of membership"] },
    { id: "uar", label: "All access rows", table: "uar" },
    { id: "email_counts", label: "E-mail row counts", table: "email_counts",
      cols: ["Manager", "Request E-mail", "Request Sent", "Users in E-mail", "Rows in E-mail", "Rows in Start User Report (same users)",
             "Rows in Review File", "Difference (E-mail - Start Report)", "Rows Match Start Report", "To: and List Agree",
             "Missing Rows (first 10)"] },
    { id: "managers", label: "Managers", table: "managers",
      cols: ["Manager", "Users", "Access Rows", "Approved Rows", "Rejected Rows", "Request Sent", "Response Date", "Days to Respond",
             "@Responded within", "Responded By", "Reply Sent by Manager", "Matched Using", "Reading Method", "Decision",
             "Decision Quote", "Users To Remove (per e-mail)",
             "E-mail vs Review File", "Exception Rows"] },
    { id: "removals", label: "Removals", table: "removals" },
    { id: "completeness", label: "Completeness", table: "completeness" },
    { id: "movement", label: "Movement", table: "movement" },
    { id: "ipe", label: "Report checks", table: "ipe" },
    { id: "request_rows", label: "E-mailed rows", table: "request_rows" },
    { id: "emails", label: "E-mails", table: "emails",
      cols: ["File", "Message", "Author", "To", "Sent", "Classification", "Matched Manager", "Matched Using", "Read By",
             "Decision", "Summary"] },
  ];

  function tabRows(tab) {
    const t = results.tables[tab.table];
    return tab.filter ? t.rows.filter((r) => tab.filter(r, t)) : t.rows;
  }

  function renderTabs() {
    $("#tabs").innerHTML = TABS.map((tab) =>
      `<button type="button" role="tab" data-tab="${tab.id}" aria-selected="${tab.id === tableState.tab}">${esc(tab.label)}` +
      `<span class="count">${tabRows(tab).length}</span></button>`).join("");
    renderTable();
  }
  $("#tabs").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-tab]");
    if (!b) return;
    tableState.tab = b.dataset.tab; tableState.page = 0;
    document.querySelectorAll("#tabs button").forEach((x) => x.setAttribute("aria-selected", x === b));
    renderTable();
  });
  $("#tableSearch").addEventListener("input", (e) => { tableState.filter = e.target.value.toLowerCase(); tableState.page = 0; renderTable(); });

  const WRAP = new Set(["Exception Detail", "Comments", "Email cross-check", "E-mail vs Review File", "Decision Quote",
    "Summary", "Missing Rows (first 10)", "Request E-mail", "Feedback Mail", "Manager Reply Text", "Text", "Subject", "Source", "Removal Verified", "Explained by Review",
    "AI: Names Not Matched / Not Verified", "Start listing", "Post-review listing", "Check"]);
  function cellClass(v, col) {
    const s = String(v ?? "");
    const w = WRAP.has(col) ? " wrap" : "";
    return cellTone(s) + w;
  }
  function cellTone(s) {
    if (/^(EXCEPTION|NOT supported|NOT addressed|Conflict|No - \d|No response|Self-approval$)/.test(s)) return "v-bad";
    if (/^(Removed - OK|Retained - OK|Consistent|Supported)/.test(s)) return "v-ok";
    return "";
  }

  function renderTable() {
    const tab = TABS.find((t) => t.id === tableState.tab);
    const t = results.tables[tab.table];
    const cols = (tab.cols || t.columns)
      .map((c) => (c.startsWith("@") ? t.columns.find((x) => x.startsWith(c.slice(1))) : c))
      .filter((c) => c && t.columns.includes(c));
    const idx = cols.map((c) => t.columns.indexOf(c));
    const excI = t.columns.indexOf("Exception");
    let data = tabRows(tab);
    if (tableState.filter) data = data.filter((r) => r.some((v) => String(v ?? "").toLowerCase().includes(tableState.filter)));
    const pages = Math.max(1, Math.ceil(data.length / PAGE));
    tableState.page = Math.min(tableState.page, pages - 1);
    const slice = data.slice(tableState.page * PAGE, (tableState.page + 1) * PAGE);
    $("#detailTable").innerHTML =
      `<thead><tr>${cols.map((c) => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead><tbody>` +
      (slice.length ? slice.map((r) =>
        `<tr class="${excI >= 0 && r[excI] === "Yes" ? "flag" : ""}">${idx.map((i, k) => `<td class="${cellClass(r[i], cols[k])}">${esc(r[i])}</td>`).join("")}</tr>`).join("")
        : `<tr><td colspan="${cols.length}">${tableState.filter ? "No rows match the filter." : "Nothing to show here."}</td></tr>`) +
      "</tbody>";
    $("#tableCount").textContent = `${data.length} row${data.length === 1 ? "" : "s"}`;
    $("#pager").innerHTML = pages > 1 ?
      `<button type="button" class="btn btn-ghost" data-page="-1" ${tableState.page === 0 ? "disabled" : ""}>Previous</button>
       <span>Page ${tableState.page + 1} of ${pages}</span>
       <button type="button" class="btn btn-ghost" data-page="1" ${tableState.page >= pages - 1 ? "disabled" : ""}>Next</button>` : "";
  }
  $("#pager").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-page]");
    if (b) { tableState.page += +b.dataset.page; renderTable(); }
  });

  // ------------------------------------------------------------------ previous runs
  $("#runsSelect").addEventListener("change", async (e) => {
    const id = e.target.value;
    if (!id) return;
    try {
      const j = await api(`/runs/${encodeURIComponent(id)}`);
      currentRun = id;
      showLog(j.log || []);
      if (j.status === "done") { setDone("run", true); renderResults(j); document.getElementById("results").scrollIntoView(); }
      else if (j.status === "queued" || j.status === "running") { $("#progress").hidden = false; startPolling(id); }
      else showLog([...(j.log || []), "", `This run failed: ${j.error || "unknown error"}.`], false);
    } catch (err) { showLog([err.message], true); }
  });

  // ------------------------------------------------------------------ chat
  const SUGGESTIONS = [
    "Which managers responded late or not at all?",
    "Which managers' e-mailed lists don't match the start listing?",
    "List users whose rejected access is still active",
    "Which approved users have never logged in?",
    "Summarise exceptions by manager",
    "Which rejections are not supported by the manager's e-mail?",
  ];

  function enableChat(runId) {
    chatHistory = [];
    const log = $("#chatLog");
    log.innerHTML = "";
    const on = aiEnabled;
    $("#chatInput").disabled = !on;
    $("#chatSend").disabled = !on;
    if (!on) {
      log.innerHTML = '<div class="empty">Chat needs Azure OpenAI. Add the AZURE_OPENAI_* settings to backend/.env and restart the backend.</div>';
      $("#suggestions").innerHTML = "";
      return;
    }
    log.innerHTML = '<div class="empty" id="chatEmpty">Ask about this run. For example, pick one of the questions below.</div>';
    $("#suggestions").innerHTML = SUGGESTIONS.map((q) => `<button type="button">${esc(q)}</button>`).join("");
    $("#suggestions").hidden = false;
    currentRun = runId;
  }
  $("#suggestions").addEventListener("click", (e) => {
    if (e.target.tagName === "BUTTON") { $("#chatInput").value = e.target.textContent; $("#chatForm").requestSubmit(); }
  });
  $("#chatInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#chatForm").requestSubmit(); }
  });

  function mdLite(text) {
    const lines = esc(text).split("\n");
    let html = "", inList = false;
    for (const raw of lines) {
      const l = raw.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
      const m = /^\s*(?:[-*•]|\d+\.)\s+(.*)$/.exec(l);
      if (m) { if (!inList) { html += "<ul>"; inList = true; } html += `<li>${m[1]}</li>`; continue; }
      if (inList) { html += "</ul>"; inList = false; }
      html += l.trim() ? `<p>${l}</p>` : "";
    }
    return html + (inList ? "</ul>" : "");
  }

  function stepsHtml(steps) {
    if (!steps || !steps.length) return "";
    const parts = steps.map((s, n) => {
      let body = `<pre>${esc(s.sql)}</pre>`;
      if (s.error) body += `<div class="q-err">Not run: ${esc(s.error)}</div>`;
      else {
        const head = `<tr>${s.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr>`;
        const rowsH = s.rows.slice(0, 10).map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join("")}</tr>`).join("");
        body += `<div class="table-wrap"><table>${head}${rowsH}</table></div><div>${s.row_count} row${s.row_count === 1 ? "" : "s"}` +
          `${s.row_count > 10 ? ", first 10 shown" : ""}</div>`;
      }
      return `<div><strong>Query ${n + 1}</strong>${body}</div>`;
    }).join("");
    return `<details><summary>How this was answered (${steps.length} quer${steps.length === 1 ? "y" : "ies"})</summary>${parts}</details>`;
  }

  function addMsg(cls, html) {
    const empty = $("#chatEmpty"); if (empty) empty.remove();
    const d = document.createElement("div");
    d.className = `msg ${cls}`;
    d.innerHTML = html;
    $("#chatLog").appendChild(d);
    $("#chatLog").scrollTop = $("#chatLog").scrollHeight;
    return d;
  }

  $("#chatForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#chatInput").value.trim();
    if (!q || !currentRun || $("#chatSend").disabled) return;
    $("#chatInput").value = "";
    $("#suggestions").hidden = true;
    addMsg("msg-user", esc(q));
    const wait = addMsg("msg-bot", '<span class="typing">Looking at the results ...</span>');
    $("#chatSend").disabled = true;
    try {
      const r = await api(`/runs/${encodeURIComponent(currentRun)}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: q, history: chatHistory }),
      });
      wait.innerHTML = mdLite(r.answer) + stepsHtml(r.steps);
      chatHistory.push({ role: "user", content: q }, { role: "assistant", content: r.answer });
      setDone("chat", true);
    } catch (err) {
      wait.classList.add("msg-err");
      wait.innerHTML = esc(err.message);
    } finally {
      $("#chatSend").disabled = !aiEnabled;
      $("#chatInput").focus();
    }
  });

  // ------------------------------------------------------------------ start
  renderPBC();
  syncDetails();
  checkHealth();
})();
