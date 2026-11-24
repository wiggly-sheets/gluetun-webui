// Small TTL cache for read-through lookups.
// get(key, fetchFn, ttlMs) returns fresh data, a shared in-flight promise, stale data
// while a refresh runs (staleWhileRevalidate), or null during a negative-cache window.
function createCache({ ttlMs = 0, staleWhileRevalidate = false, negativeTtlMs = 0, maxEntries = Infinity, now = Date.now } = {}) {
  const entries = new Map();

  function store(key, value) {
    entries.set(key, value);
    if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  }

  function get(key, fetchFn, entryTtlMs = ttlMs) {
    const entry = entries.get(key);
    if (entry?.pending) return entry.pending;
    if (entry?.failUntil > now()) return null;
    if (entry && entry.expires > now()) return entry.data;

    if (staleWhileRevalidate && entry && 'data' in entry) {
      if (!entry.refreshing) {
        entry.refreshing = true;
        Promise.resolve()
          .then(fetchFn)
          .then(data => store(key, { data, expires: now() + entryTtlMs }))
          .catch(() => { entry.refreshing = false; });
      }
      return entry.data;
    }

    const pending = Promise.resolve()
      .then(fetchFn)
      .then(data => {
        store(key, { data, expires: now() + entryTtlMs });
        return data;
      })
      .catch(err => {
        if (negativeTtlMs > 0) {
          store(key, { failUntil: now() + negativeTtlMs });
        } else if (staleWhileRevalidate && entry && 'data' in entry) {
          entry.refreshing = false; // keep the stale entry so the next call retries
        } else {
          entries.delete(key);
        }
        throw err;
      });
    store(key, { pending });
    return pending;
  }

  function remove(key) { entries.delete(key); }

  return { get, delete: remove };
}

module.exports = { createCache };
