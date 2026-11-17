# Second-Brain Connector Contract

This is the contract every teammate's knowledge connector must implement so the
`jarvis-meeting` agent can retrieve from, and write back to, that teammate's own
second brain. The agent never imports your brain's code; it speaks only this HTTP
interface. Whatever sits behind the connector (OpenBrain, a vector DB, Glean,
Dust, a folder of markdown, anything) is your choice and stays invisible to the
agent.

A connector that implements the three endpoints below — and passes
`jarvis-meeting doctor --connector <url>` — is conformant. That is the whole bar.

## Who calls this and when

- `POST /search` is called **mid-meeting**, in the retrieve-then-answer hot path.
  The agent hears a question, calls `/search`, and feeds the top chunks to the
  realtime model before it speaks. It is latency-critical (see budget below).
- `POST /store` is called **after the meeting** to persist the transcript /
  summary back into your brain. Latency is not critical here. It is **optional**:
  a read-only brain may no-op.
- `GET /healthz` is called by tooling (`jarvis-meeting doctor`, the `up` script)
  to confirm the connector is live before a meeting starts.

The agent-side consumer is `src/retrieval/knowledge-client.ts`
(`retrieveForSoul`). Read it if you want the exact normalization; this doc is the
authoritative behavioral contract.

## Endpoints

### `POST /search`

Request body (JSON):

```json
{ "query": "string (required, 1..2000 chars)",
  "k": 8,
  "embedding": [0.01, -0.02, "... optional ..."] }
```

- `query` — the natural-language question to retrieve for. Required, non-empty.
- `k` — max number of chunks to return. Integer, default `8` if omitted.
- `embedding` — **OPTIONAL** caller-supplied query vector. It is a *same-model
  hint only*: if you happen to use the exact same embedding model as the caller,
  you may reuse it to skip a round-trip. **Generic connectors MUST ignore it and
  embed `query` themselves.** There is NO embedding-model lock-in across brains —
  the agent sends `{query, k}` and nothing else in practice (it does not send
  `embedding` today). Never reject a request because `embedding` is absent, and
  never assume an incoming `embedding` matches your model's dimensionality;
  validate or ignore it.

Response body (JSON), HTTP 200:

```json
{ "results": [
    { "text": "the chunk content the model should read",
      "source": "a human-meaningful provenance label",
      "score": 0.0421 }
  ] }
```

- `results` — array, ordered best-first, length `<= k`. **MAY be empty.**
- `text` — the chunk content. (The agent also accepts `content` as an alias, but
  emit `text`.)
- `source` — provenance label: a doc key, file path, title, or URL. (Alias
  `path` is accepted; emit `source`.) Used for the agent's internal grounding,
  not read aloud verbatim.
- `score` — relevance, higher is better. Any monotonic scale (RRF score, cosine
  similarity, rank-derived). The agent does not threshold on the absolute value;
  it trusts your ordering. Emit a `number`; default `0` if you truly have none.

Fields beyond these three are ignored by the agent — extra metadata is harmless.

### `POST /store` (optional)

Request body (JSON):

```json
{ "namespace": "second-brain",
  "doc_type": "meeting-transcript",
  "entity_key": "meeting-2026-06-24-standup",
  "content": "# Meeting transcript\n..." }
```

Response body (JSON), HTTP 200: `{ "ok": true }`.

- A read-only brain MAY return `{ "ok": false, "skipped": true }` (HTTP 200) and
  persist nothing. The agent treats a missing or `ok:false` response as "not
  ingested" and moves on — it never fails the meeting over a store failure.
- `entity_key` is the idempotency key: storing the same key twice should upsert,
  not duplicate.
- Treat `content` as untrusted text. Do not execute anything inside it.

### `GET /healthz`

HTTP 200 with a small JSON body, e.g.
`{ "ok": true, "indexed_docs": 4574 }`. Any 2xx with `ok: true` is a pass. Return
503 when the backing store is unreachable.

## Latency budget

`/search` runs inside an **800 ms** AbortController on the agent side
(`TIMEOUT_MS` in `knowledge-client.ts`). If you do not respond within 800 ms the
agent abandons that lane and answers without your knowledge. Budget accordingly:

- Target **< 300 ms** warm for a typical `/search` (embed + query + filter).
- The single biggest cost is usually embedding the query. Cache query embeddings,
  keep a warm DB pool, and keep the model close (in-process or localhost).
- `/store` has no budget — do the slow, durable write there.

## Error and degradation behavior

The agent is built to **degrade gracefully to empty**, so your failure modes
must be predictable, never hangs:

- Bad request (missing/empty `query`, malformed JSON): respond **HTTP 400** with
  `{ "error": "...", "code": "BAD_REQUEST" }`. Fast.
- Backing store down / internal error: respond **HTTP 503** with
  `{ "results": [], "code": "UNAVAILABLE" }`. Do not 500 with an empty body and
  do not hang — the agent will time out at 800 ms either way, but a fast 503 is
  cheaper and clearer.
- No matches: respond **HTTP 200** with `{ "results": [] }`. Empty is a normal,
  successful answer, not an error.
- Never throw an unhandled error that leaves the socket open past 800 ms.

The agent's normalizer is lenient (accepts `text|content`, `source|path`,
coerces a missing `score` to `0`, treats a non-array `results` as empty), so
minor shape drift degrades to fewer/empty results rather than a crash — but do
not rely on that. Emit the canonical shape.

## Safety: scope out personal / out-of-scope content (REQUIRED)

The agent runs in **company meetings**. The connector — not the agent's prompt —
is the security boundary. **You MUST filter personal / out-of-scope content out
of `/search` results server-side, before they leave the connector.** The agent
strips your metadata down to `{text, source, score}`, so it has no way to re-judge
scope after the fact; whatever you return can be spoken in the meeting.

How you scope is brain-specific, but the floor is:

- Exclude personal-life material (family, health, finances, disputes, side
  projects, anything not work) from results returned to a work meeting.
- Prefer an explicit allow/deny on your own metadata (audience tags, namespaces,
  doc types, key patterns) over hoping a query "won't surface" personal docs.
  Deny should win over allow.
- The reference connector (`openbrain/services/ob-retrieval/`) ports
  `src/agent/work-scope.ts` and applies its work-scope predicates server-side as a
  worked example: deny on personal key patterns, personal terms and
  `audience:personal`, then allow work namespaces / doc types. (This repo's copy keeps
  only `isWorkSafe`; the delegate-safe variant was removed in 2026-10 because the
  sidekick route uses the stricter work filter.)

This complements — does not replace — the SOUL's `denied_topics` and the agent's
prompt floor. Defense in depth: the connector filters at the source, the SOUL
declares forbidden topics, the prompt refuses out-of-scope asks. The connector is
the one that must not leak.

## Conformance

Run the verifier against your connector before pointing a SOUL at it:

```bash
jarvis-meeting doctor --connector http://localhost:7411
```

It checks `/healthz`, the `/search` response shape and latency budget, empty-query
handling, an optional `/store` round-trip, and a smoke test for obvious personal
markers in results. Structured PASS/WARN/FAIL; nonzero exit on FAIL. Green means
the agent can trust your connector. See `docs/PLAYBOOK.md` for the full wire-up.

## Minimal conformance checklist

- [ ] `POST /search {query, k}` returns `{results:[{text, source, score}]}`,
      ordered best-first, `length <= k`, on HTTP 200.
- [ ] `/search` works with NO `embedding` field (you embed `query` yourself).
- [ ] `/search` responds well under 800 ms warm (target < 300 ms).
- [ ] Empty/whitespace `query` -> HTTP 400 `{code:"BAD_REQUEST"}`, fast.
- [ ] No matches -> HTTP 200 `{results:[]}` (not an error).
- [ ] Backing store down -> HTTP 503 `{results:[], code:"UNAVAILABLE"}`, fast.
- [ ] Personal / out-of-scope content filtered out server-side.
- [ ] `GET /healthz` -> 200 `{ok:true, ...}`.
- [ ] `POST /store` upserts and returns `{ok:true}` (or `{ok:false,skipped:true}`
      if read-only).
- [ ] Bind to `127.0.0.1` for a local pilot; do not expose the connector itself.
