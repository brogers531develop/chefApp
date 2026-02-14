import express from "express";
import http from "http";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Server } from "socket.io";

import { runAgent } from "./agents/runAgent.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET","POST"] } });

// Serve /public
app.use(express.static(path.join(__dirname, "public")));

// ---- Model routing (fast where it matters; smart where it matters)
const MODELS = {
  manager: "gpt-5.2",
  analyzer: "gpt-5.2",
  chef_plan: "gpt-5.2",

  // Execution + logistics: faster models
  chef_exec: "gpt-5-mini",
  purchasing: "gpt-5-mini",
  delivery: "gpt-5-mini"
};

function ts(){ return Date.now(); }
function emitStatus(socket, s){
  socket.emit("job:status", s);
}
function emitMsg(socket, { fromAgent, toAgent, type="message", content, artifact=null }){
  socket.emit("agent:message", { fromAgent, toAgent, type, content, artifact, ts: ts() });
}
function makeId(){
  return Math.random().toString(16).slice(2) + "-" + Math.random().toString(16).slice(2);
}

// In-memory cook sessions (dev)
const cookSessions = new Map(); // sessionId => { timeline, idx, prompt, zipCode, personality }

async function ensureTimeline({ prompt, zipCode, personality }) {
  // First attempt
  const a = await runAgent({
    agentKey: "chef",
    model: MODELS.chef_exec,
    task: `Create a minute-by-minute execution script for cooking "${prompt}".
Beginner friendly, confidence-building.
Output MUST include a JSON artifact in \`\`\`json\`\`\` fences with:
{
  "timeline":[
    {"t_start_sec":0,"t_end_sec":90,"instruction":"...","critical":true,"voiceCue":true}
  ]
}
Rules:
- First 5 minutes must be extremely explicit.
- Include recovery notes in instruction when critical.
ZIP: ${zipCode}
Personality: ${personality}
`
  });

  const timeline = a.artifact?.timeline;
  if (Array.isArray(timeline) && timeline.length) return a;

  // One strict retry (common fix when model forgets JSON fence)
  const b = await runAgent({
    agentKey: "chef",
    model: MODELS.chef_exec,
    task: `RETRY (STRICT). Return ONLY ONE JSON code block with schema:
\`\`\`json
{"timeline":[{"t_start_sec":0,"t_end_sec":90,"instruction":"...","critical":true,"voiceCue":true}]}
\`\`\`
No extra text outside the JSON fence.

Dish: ${prompt}
ZIP: ${zipCode}
Personality: ${personality}
`
  });

  return b;
}

io.on("connection", (socket) => {
  console.log("client connected:", socket.id);

  // ---- JOB:START (plan + agents)
  socket.on("job:start", async ({ prompt, zipCode }) => {
    try{
      if (!prompt || !zipCode) {
        socket.emit("job:error", "Missing prompt or zipCode");
        return;
      }

      emitStatus(socket, "running");

      // Manager -> Chef (plan)
      emitStatus(socket, "planning");
      emitMsg(socket, {
        fromAgent: "Manager",
        toAgent: "Chef",
        type: "delegation",
        content: `We need a full plan for "${prompt}". ZIP ${zipCode}. Provide steps, timeline, risks, and a shopping list.`
      });

      const chef = await runAgent({
        agentKey: "chef",
        task: `Dish: ${prompt}\nZIP: ${zipCode}\nReturn a clear plan + shopping list + timeline.\nInclude JSON artifact in \`\`\`json\`\`\` fences.`,
        model: MODELS.chef_plan
      });

      emitMsg(socket, { fromAgent:"Chef", toAgent:"Manager", content: chef.message, artifact: chef.artifact });

      // Purchasing
      emitStatus(socket, "purchasing");
      emitMsg(socket, {
        fromAgent: "Manager",
        toAgent: "Purchasing",
        type: "delegation",
        content: `Build a purchase order near ZIP ${zipCode} using the chef artifact. Include substitutes + notes.`
      });

      const purchasing = await runAgent({
        agentKey: "purchasing",
        task: `ZIP: ${zipCode}\nChef Artifact:\n${JSON.stringify(chef.artifact ?? {}, null, 2)}\nReturn JSON artifact with purchaseOrder + vendorSuggestions.`,
        model: MODELS.purchasing
      });

      emitMsg(socket, { fromAgent:"Purchasing", toAgent:"Manager", content: purchasing.message, artifact: purchasing.artifact });

      // Delivery
      emitStatus(socket, "delivery");
      emitMsg(socket, {
        fromAgent: "Manager",
        toAgent: "Delivery",
        type: "delegation",
        content: `Create a delivery plan for ZIP ${zipCode}. Estimate ETA and list stops. Respect cold items.`
      });

      const delivery = await runAgent({
        agentKey: "delivery",
        task: `ZIP: ${zipCode}\nPurchase Artifact:\n${JSON.stringify(purchasing.artifact ?? {}, null, 2)}\nReturn JSON artifact with deliveryPlan.`,
        model: MODELS.delivery
      });

      emitMsg(socket, { fromAgent:"Delivery", toAgent:"Manager", content: delivery.message, artifact: delivery.artifact });

      // Analyzer (forced convergence)
      emitStatus(socket, "analyzing");
      emitMsg(socket, {
        fromAgent:"Analyzer",
        toAgent:"Manager",
        type:"analysis",
        content:"Reviewing run and producing a convergence-grade build prompt..."
      });

      const analyzer = await runAgent({
        agentKey: "analyzer",
        task: `You are the principal architect. No hedging.
Output MUST include:
1) Positives
2) Negatives (concrete)
3) Fixes REQUIRED before next run
4) A single copy-paste BUILD PROMPT for V3. Make irreversible decisions.

Chef Artifact:
${JSON.stringify(chef.artifact ?? {}, null, 2)}

Purchasing Artifact:
${JSON.stringify(purchasing.artifact ?? {}, null, 2)}

Delivery Artifact:
${JSON.stringify(delivery.artifact ?? {}, null, 2)}
`,
        model: MODELS.analyzer
      });

      emitMsg(socket, { fromAgent:"Analyzer", toAgent:"Manager", type:"analysis", content: analyzer.message, artifact: analyzer.artifact });

      const jobId = makeId();

      socket.emit("job:final", {
        jobId,
        prompt,
        zipCode,
        chef: chef.artifact,
        purchasing: purchasing.artifact,
        delivery: delivery.artifact,
        analyzer: analyzer.artifact || analyzer.message
      });

      emitStatus(socket, "done");
    } catch (e){
      console.error("job:start failed", e);
      socket.emit("job:error", e?.message || "Unknown error in job:start");
      emitStatus(socket, "error");
    }
  });

  // ---- COOK:START (execution mode; generates time-coded timeline)
  socket.on("cook:start", async ({ jobId, prompt, zipCode, plan, personality="calm_comedic" }) => {
    try{
      if (!prompt || !zipCode) {
        socket.emit("job:error", "cook:start missing prompt/zipCode");
        return;
      }

      emitStatus(socket, "cooking");

      const sessionId = jobId || makeId();

      emitMsg(socket, {
        fromAgent:"Manager",
        toAgent:"Chef",
        type:"control",
        content:`EXECUTION MODE. Build a minute-by-minute timeline script for "${prompt}". ZIP ${zipCode}. Personality: ${personality}.`
      });

      const chefExec = await ensureTimeline({ prompt, zipCode, personality });
      const timeline = chefExec.artifact?.timeline || [];

      cookSessions.set(sessionId, { timeline, idx: 0, prompt, zipCode, personality });

      emitMsg(socket, {
        fromAgent:"Chef",
        toAgent:"User",
        type:"execution",
        content: chefExec.message || `Alright. We’re cooking "${prompt}". I’ll guide you minute-by-minute.`,
        artifact: { sessionId, personality, timelinePreview: timeline.slice(0,3) }
      });

      socket.emit("cook:ready", { sessionId });

      // Immediately push step 1 so it never feels stuck
      if (timeline[0]) {
        emitMsg(socket, {
          fromAgent:"Chef",
          toAgent:"User",
          type:"step",
          content:`Step 1 (${timeline[0].t_start_sec}s–${timeline[0].t_end_sec}s): ${timeline[0].instruction}`,
          artifact: timeline[0]
        });
      } else {
        emitMsg(socket, {
          fromAgent:"Chef",
          toAgent:"User",
          type:"step",
          content:"No timeline received. Chef did not return a timeline artifact even after retry."
        });
      }

      emitStatus(socket, "cooking-live");
    } catch (e){
      console.error("cook:start failed", e);
      socket.emit("job:error", e?.message || "Unknown error in cook:start");
      emitStatus(socket, "error");
    }
  });

  // ---- COOK:NEXT (manual stepping)
  socket.on("cook:next", ({ sessionId }) => {
    const s = cookSessions.get(sessionId);
    if (!s) return socket.emit("job:error", "No cook session found");

    const nextIdx = Math.min((s.idx ?? 0) + 1, (s.timeline.length ? s.timeline.length - 1 : 0));
    s.idx = nextIdx;

    const step = s.timeline[nextIdx];
    if (!step) {
      emitMsg(socket, { fromAgent:"Chef", toAgent:"User", type:"step", content:"No more steps." });
      return;
    }

    emitMsg(socket, {
      fromAgent:"Chef",
      toAgent:"User",
      type:"step",
      content:`Next (${step.t_start_sec}s–${step.t_end_sec}s): ${step.instruction}`,
      artifact: step
    });
  });

  socket.on("disconnect", () => console.log("client disconnected:", socket.id));
});

const PORT = process.env.PORT || 4605;
server.listen(PORT, () => console.log(`✅ CookOS V3 listening on http://localhost:${PORT}`));
