# On-device storage as a privacy position

**Date:** 2026-05-09
**Status:** Design exploration — no commitment yet
**Scope:** Privacy *of stored user data*, not of LLM inference. We continue to send transient content to Gemini Live + Gemini Pro/Flash for voice and ingestion; that's out of scope here. The question this note answers: how far can we push "your data lives on your device" without breaking the product, and what would it cost?

---

## Why this exists

Worth evaluating whether we can make a strong, marketable privacy claim — credibly enough that it shows up on a landing page and survives technical scrutiny. The strongest version of that claim is "our servers never persist your conversations or knowledge graph; everything lives only on your devices." This note maps what's actually required to be able to say that.

Tied to the Autonomy/Control principle (`project_ux_principles`) — the user owns their data is the credible version of the user is in control.

---

## Menu of privacy positions, ordered by what they actually deliver

1. **Zero-retention contracts (status quo + a paragraph in the privacy policy).** Gemini API supports no-retention / no-training terms. Marketable as "your conversations aren't stored or used to train models." Honest but unremarkable — every serious AI app claims this. Not a differentiator.
2. **E2E-encrypted cloud backup, on-device source of truth.** Device is canonical, Supabase holds an encrypted blob the server cannot decrypt. Strong claim, real cryptographic teeth, but forces ingestion onto the device and breaks our current worker model. **This note's main subject.**
3. **Confidential compute / TEE for ingestion** (Apple-PCC-style). Worker runs in an attested enclave, plaintext exists only in memory. Strongest combination of cloud-grade quality + privacy guarantee. Major infra lift, can't run on Render.
4. **Local-only mode as a tier.** Toggle that disables ingestion + agent tasks, keeping Audri as a local voice notebook. Marketing-honest, gives privacy-maxis a real option, doesn't crater the main product. Cheapest of the meaningful options.

Position #2 is the one that matches the headline marketing claim. The rest of this note is about what it actually requires.

---

## What's actually stored where today

Persistent state lives in Postgres (Supabase). Everything below is *user-content* state — auth identity is handled separately and stays server-side.

- `wiki_pages`, `wiki_sections`, junction tables (`wiki_section_transcripts`, `_urls`, `_ancestors`)
- `call_transcripts` (full transcript JSONB, prompt-cache references)
- `agent_tasks` (kind, payload, status, result)
- `research_outputs` and other future per-kind artifact tables
- Graphile job queue rows (job metadata + payload)

RxDB already mirrors a subset to the device (wiki, agent_tasks, research outputs) for read-side performance. The device is *capable* of holding the canonical copy — the question is everything else that breaks when Postgres stops being the source of truth.

---

## What changes if the device becomes canonical

### 1. Ingestion orchestration moves device-driven

Today the worker reads transcript + wiki straight from Postgres. With nothing persisted server-side, the device has to ship the relevant context up with each job.

Cleanest split:
- **Phase 1 (Flash retrieval — picks relevant pages)** runs on-device since it's a lookup against the local wiki. Cheap; no infra change in the worker, just a new mobile module.
- **Phase 2 (Pro fan-out — generates section operations)** still runs in the worker, called as a stateless inference relay: device sends `{transcript, retrieved_sections}`, worker calls Gemini Pro, returns the structured output. Worker holds nothing.
- **Phase 3 (transactional commit)** runs on-device against RxDB.
- **Agent-scope ingestion** (parallel pass, see `specs/agent-scope-ingestion.md`) follows the same shape.

Implication: `apps/worker/src/ingestion/` collapses substantially. The worker becomes a thin Gemini-call broker, not a stateful pipeline. Most of the orchestration logic moves to `apps/mobile/lib/`.

### 2. Tool calls served by the device

`search_wiki` / `fetch_page` (and any future read tools) currently route through the API → Postgres. With wiki on-device only, these have to be answered from RxDB. The good news: Gemini Live tool calls already round-trip to the client (see `apps/mobile/lib/gemini/`), so this is a wiring change in the tool-handler layer, not a new transport.

### 3. Job queue keeps Postgres but stores no content

Graphile still useful for: scheduling, retries, per-user FIFO ordering, dispatcher coordination. But payloads have to be content-free — only `{user_id, job_kind, job_id, status}`. The device passes the actual content per-invocation when the worker calls back for inference, and the worker discards after responding.

This means the **`ingestion-${user_id}` per-user FIFO queue keeps working** (it's a metadata-only construct already) — what changes is that the worker no longer pulls transcript/wiki from Postgres at job-start; it has to ask the device.

How does the worker "ask the device"? Two viable shapes:
- **Pull model:** worker exposes a job-ready signal; device polls or holds a websocket; on signal, device pushes the inference payload up. Resilient to phone offline (job waits) but adds a new transport.
- **Push model (simpler):** device drives the whole flow — runs Phase 1 locally, sends `{transcript, retrieved_sections}` to a stateless `POST /ingest/fanout` endpoint, gets the structured result back, commits Phase 3 locally. The worker isn't a worker anymore; it's a stateless inference endpoint. Graphile only re-enters the picture for genuinely background work (scheduled hygiene, research tasks).

Push model is closer to what already exists and probably the right starting point. Graphile shrinks to the agent-task dispatcher + heartbeat surface.

### 4. Multi-device sync stops being free

Today RxDB-Supabase replication handles multi-device implicitly. With Supabase holding ciphertext only, that breaks. Two real options:
- **E2E-encrypted CRDT relay** — encrypted blobs sync through Supabase as a transport; devices hold the key, do CRDT merge locally. Real engineering work but well-trod (Automerge, Yjs).
- **Single-device until further notice** — punt multi-device to a follow-on milestone. Tolerable if mobile-first is the wedge anyway.

### 5. Account recovery becomes a feature

Lose the phone = lose the wiki. Mitigations:
- **User-key-derived encrypted backup.** Key derived from user passphrase; encrypted blob stored in Supabase; server can't decrypt. Recovery requires the passphrase. Standard E2E primitive (Signal, 1Password, Standard Notes).
- **iCloud Drive backup.** Apple handles encryption; we don't have to design the key story. Limits us to Apple ecosystem and ties recovery to Apple ID — fine for an iOS-only V1 stance.
- **Print-and-store recovery key.** Trade convenience for ironclad control.

This *has* to be built — without it, "your data is only on your device" reads as "and we're telling you to lose it."

### 6. Background processing while phone is asleep

Long-running research tasks today execute server-side and write results to Postgres. With device canonical, results have nowhere persistent to land while the phone is offline. Options:
- **Cloud inbox.** Worker stashes encrypted result in a Supabase row keyed by device. Device picks it up + decrypts on next foreground. Server can't read content.
- **Wait-for-online.** Don't complete the task until the device is reachable. Simpler, less robust.
- **APNs trigger.** Push notification wakes the app to receive the result. Reliability varies.

Cloud inbox is the only option that doesn't degrade the agent experience.

### 7. Auth and persona prompts stay server-side

- Auth row (Supabase Auth) holds identity only — email/Apple ID/etc. — no user content.
- Persona prompts (`persona_prompt`, `user_prompt_notes`) are server-only by design and don't contain user-content PII; they describe agent behavior. Stay where they are.
- Activity stream, usage events, telemetry: behavioral metadata, not content. Keep server-side; document clearly in the privacy policy.

---

## What the marketing claim actually says

> Audri's servers never persist your conversations or your knowledge graph. Everything is stored only on your devices, end-to-end encrypted in transit. AI providers process content transiently — they don't store or train on it.

Footnotes (which we have to disclose without burying):
- AI providers (Google Gemini) see content in flight during voice calls and ingestion inference, under zero-retention terms.
- Account identity (email, sign-in tokens) and behavioral telemetry (call duration, error rates, feature usage) are stored server-side without content.
- Encrypted backup is opt-in; without it, losing your device means losing your data.

This is a *real* claim, not the kind every AI app makes. Comparable to Standard Notes, Apple Notes-with-Advanced-Data-Protection, or Bear's encrypted-sync mode — but applied to a voice-first knowledge OS, which doesn't currently exist.

---

## Cost estimate

In effort terms (S/M/L/XL per `backlog.md`):

- Ingestion device-rewrite (Phase 1 + Phase 3 on mobile, worker → stateless inference relay): **L–XL**.
- Tool-handler shift (`search_wiki` / `fetch_page` answered from RxDB): **M**.
- E2E-encrypted backup + key management + recovery flow: **L**.
- Cloud inbox for async agent results: **M**.
- Multi-device sync via E2E-encrypted CRDT relay: **XL** (or punt).
- Privacy-policy + consent UX rework: **S–M**.

Total: a meaningful release-cycle's worth of work. Not infrastructure we can't run on Render — no new hosting requirement. The work is concentrated in the mobile app and the ingestion orchestration; the data model itself barely changes.

---

## Open questions before this becomes a build phase

1. **Is privacy actually a wedge for our target user?** Knowledge-OS users skew technical and privacy-aware, but voice-first surfaces tend to attract convenience-first users. Worth user research before committing.
2. **Single-device or multi-device at V1+?** Determines whether E2E-CRDT-relay is in or out of scope.
3. **Hybrid model?** Could ship #4 (local-only tier) as an opt-in alongside the default cloud-mirror, hitting the privacy-maxi audience without forcing the full rewrite. Faster, weaker headline, but a real product feature.
4. **Compliance tailwind?** GDPR/CCPA/state privacy laws may make this less a marketing bet and more a cost-of-doing-business item over time. Worth scanning the regulatory horizon before scoping.
5. **Voice-layer asterisk severity.** If the privacy-conscious user finds "Google sees your voice transiently" disqualifying, the storage-only claim may not be enough — and the answer is on-device STT + LLM, which lands us back in the LLM-side conversation we explicitly scoped out.
