/**
 * Epoch-aware promotion tracker shared by the bootstrap and baseline-gate
 * plugins of the anchored presets.
 *
 * A compaction rewrites the model-visible surface: the pre-compaction
 * conversation collapses into one synthetic summary message, and the
 * workspace-instruction baseline is re-injected from scratch. The first
 * post-compaction request is therefore a "second first request" — the same
 * first-token conditions the anchored presets exist to control. Promotion is
 * epoch-aware: only a durable promotion signal (`tool/call` and/or
 * `assistant/message`, per the caller's `promoteEvents`) recorded AFTER the
 * last `compaction/end` boundary counts as promoted. Before any compaction
 * the boundary is -1, which preserves the original one-shot semantics.
 *
 * State is memoized per session id and maintained incrementally through
 * `observe()`; a cold session scans its durable log once (so resume and
 * reload reconstruct the same phase), then O(1).
 *
 * Besides `boundary` and `promoted`, the tracker counts `turn/start` events
 * since the last boundary (`turns`) and records the first promoted turn
 * (`firstPromotedTurn` = `turns + 1` at the moment of promotion), so callers
 * can schedule injections on "promoted turn N" rather than every request.
 *
 * By default subagents (`delegationDepth > 0`) are treated as already
 * promoted so their first request can use tools. Set `includeSubagents: true`
 * to make subagents follow the same bootstrap/anchor phase as top-level
 * sessions.
 */

/** Build one epoch-aware promotion tracker. */
export function createEpochPromotion(promoteEvents, options = {}) {
  const includeSubagents = options.includeSubagents === true
  const promote = new Set(promoteEvents)
  /** sessionId -> { boundary, promoted, turns, firstPromotedTurn } */
  const state = new Map()

  /** Scan a session's durable log from scratch (cold start / resume). */
  const scan = (session) => {
    let boundary = -1
    let promoted = false
    let turns = 0
    let firstPromotedTurn = null
    for (const event of session.events) {
      const seq = event.seq ?? 0 // events without a seq are treated as post-boundary
      if (event.type === 'compaction/end') {
        boundary = seq
        promoted = false
        turns = 0
        firstPromotedTurn = null
        continue
      }
      if (event.type === 'turn/start' && seq > boundary) turns += 1
      if (promote.has(event.type) && seq > boundary && !promoted) {
        promoted = true
        if (firstPromotedTurn === null) firstPromotedTurn = turns + 1
      }
    }
    const entry = { boundary, promoted, turns, firstPromotedTurn }
    state.set(session.id, entry)
    return entry
  }

  return {
    /**
     * Current phase of the agent's session.
     * @param agent - the assembly/pre-step agent, or undefined outside an agent.
     * @returns { boundary, promoted, turns, firstPromotedTurn } — `boundary`
     *   is the last compaction/end seq (-1 before any compaction); `promoted`
     *   is true when a durable promotion signal exists after that boundary;
     *   `turns` is the number of `turn/start` events after the boundary; and
     *   `firstPromotedTurn` is the first `turns` value whose turn starts after
     *   promotion (null while unpromoted).
     */
    status(agent) {
      if (agent === undefined) return { boundary: -1, promoted: true, turns: 0, firstPromotedTurn: null }
      const session = agent.session
      if (session === undefined) return { boundary: -1, promoted: true, turns: 0, firstPromotedTurn: null }
      // By default subagents keep the full catalog from their very first
      // request; includeSubagents makes them follow the normal bootstrap phase.
      if (!includeSubagents && (session.header?.delegationDepth ?? 0) > 0) return { boundary: -1, promoted: true, turns: 0, firstPromotedTurn: null }
      return state.get(session.id) ?? scan(session)
    },
    /** Incremental feed: call on every `session/event`. */
    observe(session, event) {
      const entry = state.get(session.id)
      if (entry === undefined) return
      const seq = event.seq ?? 0
      if (event.type === 'compaction/end') {
        state.set(session.id, { boundary: seq, promoted: false, turns: 0, firstPromotedTurn: null })
        return
      }
      if (event.type === 'turn/start' && seq > entry.boundary) {
        state.set(session.id, { ...entry, turns: entry.turns + 1 })
        return
      }
      if (promote.has(event.type) && seq > entry.boundary && !entry.promoted) {
        state.set(session.id, {
          ...entry,
          promoted: true,
          firstPromotedTurn: entry.firstPromotedTurn ?? entry.turns + 1,
        })
      }
    },
  }
}
