document.addEventListener("DOMContentLoaded", () => {
  const $ = (id) => document.getElementById(id);

  const promptEl = $("promptInput");
  const zipEl = $("zipInput");
  const startBtn = $("startBtn");
  const letsCookBtn = $("letsCookBtn");
  const nextStepBtn = $("nextStepBtn");
  const resetBtn = $("resetBtn");
  const personalitySelect = $("personalitySelect");

  const connPill = $("connPill");
  const statusPill = $("statusPill");
  const jobTag = $("jobTag");
  const thread = $("thread");
  const finalOutput = $("finalOutput");

  if (typeof io !== "function") {
    alert("Socket.IO client not loaded. Check script tags.");
    return;
  }

  const socket = io();
  let current = { jobId: null, sessionId: null, prompt: null, zipCode: null, final: null };
  let lastStatus = "idle";

  const escapeHtml = (s) => String(s ?? "")
    .replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;")
    .replaceAll('"',"&quot;").replaceAll("'","&#039;");

  const validZip = (zip) => /^\d{5}(-\d{4})?$/.test(zip);

  function setConn(t){ connPill.textContent = t; }
  function setStatus(t){
    lastStatus = t || "unknown";
    statusPill.textContent = `Status: ${lastStatus}`;
  }

  function badgeClass(agent){
    const a = (agent||"").toLowerCase();
    if (a.includes("manager")) return "manager";
    if (a.includes("chef")) return "chef";
    if (a.includes("purch")) return "purchasing";
    if (a.includes("deliver")) return "delivery";
    if (a.includes("analy")) return "status";
    if (a.includes("system") || a.includes("user")) return "status";
    return "status";
  }

  function renderMsg({ fromAgent, toAgent, content, ts, artifact, type }){
    const when = ts ? new Date(ts).toLocaleTimeString() : new Date().toLocaleTimeString();
    const from = fromAgent || "System";
    const to = toAgent ? ` → ${toAgent}` : "";
    const c = escapeHtml(content || "");
    const cls = badgeClass(from);
    const hasArtifact = artifact && (typeof artifact === "object" || typeof artifact === "string");
    const artifactText = hasArtifact
      ? escapeHtml(typeof artifact === "string" ? artifact : JSON.stringify(artifact, null, 2))
      : "";

    const el = document.createElement("div");
    el.className = "msg";
    el.innerHTML = `
      <div class="meta">
        <div class="fromto">${escapeHtml(from)}${escapeHtml(to)} • ${when}</div>
        <div class="badge ${cls}">${escapeHtml(type || "message")}</div>
      </div>
      <div class="content">${c}</div>
      ${hasArtifact ? `
        <details class="artifact">
          <summary class="small">View artifact</summary>
          <pre>${artifactText}</pre>
        </details>
      ` : ""}
    `;
    thread.appendChild(el);
    thread.scrollTop = thread.scrollHeight;
  }

  function clearUI(){
    thread.innerHTML = "";
    finalOutput.textContent = "";
    current = { jobId:null, sessionId:null, prompt:null, zipCode:null, final:null };
    jobTag.textContent = "No job yet";
    letsCookBtn.disabled = true;
    nextStepBtn.disabled = true;
    setStatus("idle");
  }

  // Socket lifecycle
  socket.on("connect", () => setConn("● connected"));
  socket.on("disconnect", () => setConn("● disconnected"));

  socket.on("job:status", (s) => setStatus(s || "unknown"));

  socket.on("agent:message", (msg) => {
    renderMsg({
      fromAgent: msg?.fromAgent,
      toAgent: msg?.toAgent,
      content: msg?.content,
      artifact: msg?.artifact,
      type: msg?.type || "message",
      ts: msg?.ts
    });
  });

  socket.on("job:final", (payload) => {
    current.jobId = payload?.jobId || null;
    current.prompt = payload?.prompt || current.prompt;
    current.zipCode = payload?.zipCode || current.zipCode;
    current.final = payload;

    jobTag.textContent = current.jobId ? `Job: ${current.jobId}` : "Job: (no id)";
    finalOutput.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);

    letsCookBtn.disabled = false;
    renderMsg({
      fromAgent: "System",
      type: "status",
      content: "Plan ready. Press LET’S COOK to generate an execution script.",
      ts: Date.now()
    });
  });

  socket.on("cook:ready", ({ sessionId }) => {
    current.sessionId = sessionId;
    nextStepBtn.disabled = false;

    renderMsg({
      fromAgent: "System",
      type: "status",
      content: `Cook session ready. sessionId=${sessionId}. Use Next Step to advance.`,
      ts: Date.now()
    });
  });

  socket.on("job:error", (err) => {
    const msg = typeof err === "string" ? err : (err?.message || "Unknown error");
    renderMsg({ fromAgent:"System", type:"error", content:`Error → ${msg}`, ts: Date.now() });

    // If we error during cooking, let the user try again.
    if (lastStatus.startsWith("cooking")) {
      letsCookBtn.disabled = false;
    }
    alert(msg);
  });

  // UI actions
  startBtn.addEventListener("click", () => {
    const prompt = promptEl.value.trim();
    const zipCode = zipEl.value.trim();
    if (!prompt) return alert("Enter a dish request.");
    if (!validZip(zipCode)) return alert("Enter a valid ZIP.");

    clearUI();
    current.prompt = prompt;
    current.zipCode = zipCode;

    renderMsg({ fromAgent:"User", toAgent:"Manager", type:"user", content:`${prompt} (ZIP: ${zipCode})`, ts: Date.now() });
    socket.emit("job:start", { prompt, zipCode });
  });

  letsCookBtn.addEventListener("click", () => {
    if (!current.final) return alert("No plan loaded yet. Start a job first.");

    letsCookBtn.disabled = true;
    setStatus("cooking");

    const personality = personalitySelect.value;

    renderMsg({ fromAgent:"User", toAgent:"Chef", type:"control", content:`LET’S COOK (${personality})`, ts: Date.now() });
    socket.emit("cook:start", {
      jobId: current.jobId,
      prompt: current.prompt,
      zipCode: current.zipCode,
      plan: current.final,
      personality
    });
  });

  nextStepBtn.addEventListener("click", () => {
    if (!current.sessionId) return alert("No cook session yet. Press LET’S COOK first.");
    socket.emit("cook:next", { sessionId: current.sessionId });
  });

  resetBtn.addEventListener("click", () => clearUI());
});
