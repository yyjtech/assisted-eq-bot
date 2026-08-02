let kv = null;

try {
  ({ kv } = require('@vercel/kv'));
} catch (err) {
  console.warn('Vercel KV not available, using in-memory fallback', err.message);
}

// Remembers which triage-channel thread a given source message was already
// forwarded to, so a second/third :emoji: reaction on the same message adds
// a reply instead of creating a duplicate thread.
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const fallbackStore = new Map();

function keyFor(channel, ts) {
  return `forwarded:${channel}:${ts}`;
}

function canUseKv() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    return false;
  }

  if (!kv) {
    return false;
  }

  try {
    return typeof kv.get === 'function' && typeof kv.set === 'function';
  } catch (err) {
    console.warn('Unable to inspect Vercel KV client', err.message);
    return false;
  }
}

async function getExistingThreadTs(channel, ts) {
  const key = keyFor(channel, ts);

  if (!canUseKv()) {
    return fallbackStore.get(key) || null;
  }

  try {
    return await kv.get(key);
  } catch (err) {
    console.warn('Vercel KV unavailable, falling back to in-memory deduplication', err);
    return fallbackStore.get(key) || null;
  }
}

async function rememberThreadTs(channel, ts, threadTs) {
  const key = keyFor(channel, ts);

  if (!canUseKv()) {
    fallbackStore.set(key, threadTs);
    return;
  }

  try {
    await kv.set(key, threadTs, { ex: TTL_SECONDS });
  } catch (err) {
    console.warn('Vercel KV unavailable, falling back to in-memory deduplication', err);
    fallbackStore.set(key, threadTs);
  }
}

module.exports = { getExistingThreadTs, rememberThreadTs };
