# Upstream attribution

`src/topic-label.ts` ports `normalizeTopicLabel` and the `bubbleLabel` fallback from DSH `src/topic-label.ts` and `src/bubble-projection.ts`, commit `a943701ad5fcd93d70e05cf409206c14da325b44` (MIT). The fallback is exported against the descriptor fields it uses. Desktop state supplies the resulting label without changing the copied client renderer or styles.

Core modules and tests were ported from YunongDai2005/dsh-theone, MIT License, commit fe436d005be92541ceb82495eacf83d7230c2488. Original copyright is retained in LICENSE.

The DSH model transport is removed from llm-router.ts; host-specific types are mapped in host-types.ts. New Codex/MCP integration is implemented separately. See docs/source-audit.md for the source baseline.

The client adapter also directly copies the original sidebar button CSS and cell animation from the local DSH `src/client.ts`. See `client-adapter/brand-source.json` for that file's hash and the copied portions. React bindings, theme-variable mapping and native navigation are adapted for Codex; the DSH visual design is retained.

The topic-cell renderer, physics, gestures, details, all-topics list, and locale text are copied unchanged from DSH 0.4.6, commit `a943701ad5fcd93d70e05cf409206c14da325b44`, in `client-adapter/upstream/`. Exact file hashes are recorded in `client-adapter/foam-source.json`. `foam-adapter.mjs` provides the separate Codex state/action binding; it does not fabricate routing events or task activity.

The locally copied Codex desktop runtime under `.theone/desktop-client/` is not covered by this project's MIT license and is not a distributable project artifact.

`src/history-classification.ts` ports the catalog prompt, strict assignment validator and folder exclusion boundaries from DSH commit `a943701ad5fcd93d70e05cf409206c14da325b44`. `history-catalog.ts` adapts that flow to stable Codex turn IDs, native session pagination and a separate persisted consent record. `codex-history.ts` uses the installed Codex App Server protocol, with ephemeral structured classification and execution integrations disabled. Native compaction summaries are not exposed by this history adapter; it classifies bounded user/assistant excerpts instead.
