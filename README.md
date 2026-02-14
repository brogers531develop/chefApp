# CookOS V3 (Optimized) — 2–5 minute README

## What this is
A Node/Express/Socket.IO app that visualizes multi-agent coordination (Manager, Chef, Purchasing, Delivery, Analyzer)
and adds an Execution Mode (“LET’S COOK”) that generates a time-coded cooking timeline.

## Run
1) Copy env:
   cp .env.example .env
   (paste your OpenAI key)
2) Install + start:
   npm install
   npm run dev
3) Open:
   http://localhost:4605

## Why it’s faster + smarter (model routing)
- Planner/Arbitration: GPT-5.2 (Manager + Analyzer + Chef planning)
- Execution + logistics: GPT-5 mini (Chef execution timeline, Purchasing, Delivery)
This keeps “LET’S COOK” snappy while keeping architecture and convergence high-quality.

## Socket events
Client -> Server
- job:start { prompt, zipCode }
- cook:start { jobId, prompt, zipCode, plan, personality }
- cook:next  { sessionId }

Server -> Client
- job:status
- agent:message (includes optional artifact)
- job:final
- cook:ready { sessionId }
- job:error

## Where to extend next
- Auto-timed cooking (schedule emits based on t_start_sec / t_end_sec)
- ElevenLabs voice: speak each step where voiceCue=true
- Persist cookSessions in Mongo instead of memory
# chefApp
# chefApp
