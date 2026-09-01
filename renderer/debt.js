// Milpa Desktop — debt-signal aggregation (greenhouse decisions/0183, primitive #5).
// Pure: counts the distinct `session.debt_signaled` kinds in a session's events array,
// most-frequent first (ties break alphabetically, so the order is deterministic).
// Kept free of DOM and Electron on purpose, so it can be exercised headless (node)
// against a synthetic stream; the renderer consumes it as window.milpaDebt.
;(function (root) {
  'use strict'
  function countDebtSignals (events) {
    const counts = Object.create(null)
    for (const e of (Array.isArray(events) ? events : [])) {
      if (!e || e.type !== 'session.debt_signaled') continue
      const p = e.payload || {}
      const kind = (typeof p.signal === 'string' && p.signal) ? p.signal : 'unknown'
      counts[kind] = (counts[kind] || 0) + 1
    }
    return Object.keys(counts)
      .map((kind) => ({ kind, count: counts[kind] }))
      .sort((a, b) => (b.count - a.count) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0))
  }
  const api = { countDebtSignals }
  if (typeof module !== 'undefined' && module.exports) module.exports = api
  if (root) root.milpaDebt = api
})(typeof window !== 'undefined' ? window : null)
