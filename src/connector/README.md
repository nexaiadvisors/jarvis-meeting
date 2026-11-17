# folder-connector — the bundled zero-infra default brain

A self-contained implementation of the second-brain connector contract
(`docs/CONNECTOR.md`) over a folder of `.md`/`.markdown`/`.txt` files. It exists
so teammate onboarding is **self-contained**: a colleague who has only this repo
gets a working brain with one command — no Postgres, no pgvector, no embedding
API key.

## Run

```bash
KB_ROOT=/path/to/your/docs npm run connector     # serves http://127.0.0.1:7412
```

Env: `KB_ROOT` (folder to index, required), `KB_RETRIEVAL_PORT` (default 7412).

## Endpoints (per docs/CONNECTOR.md)

- `POST /search {query, k}` -> `{results:[{text, source, score}]}` — in-memory
  **BM25** over the folder's chunks (keyword ranking; `source` = relative path).
- `POST /store {namespace, doc_type, entity_key, content}` -> `{ok:true}` — writes
  `${KB_ROOT}/<doc_type>/<entity_key>.md` and rebuilds the index (transcripts
  persist as files).
- `GET /healthz` -> `{ok, indexed_chunks, kb_root}`; `POST /reindex` -> rebuild.

## Trade-off

Keyword BM25 only — no semantic recall. Great for a curated folder of work docs;
when you outgrow it, swap in a pgvector connector per `docs/CONNECTOR.md` (e.g.
the openbrain `kb-retrieval` / `ob-retrieval` references) — the agent and the
SOUL don't change, only the endpoint.

## Scope / safety

The **folder is the scope boundary** — only put work-safe content in it; the
connector returns whatever is indexed. Bind to `127.0.0.1`.

Verify conformance: `npm run cli -- doctor --connector http://127.0.0.1:7412`.
