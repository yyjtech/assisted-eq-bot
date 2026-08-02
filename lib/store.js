const { kv } = require('@vercel/kv');

// Remembers which triage-channel thread a given source message was already
// forwarded to, so a second/third :emoji: reaction on the same message adds
// a reply instead of creating a duplicate thread.
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

function keyFor(channel, ts) {
  return `forwarded:${channel}:${ts}`;
}

async function getExistingThreadTs(channel, ts) {
  return kv.get(keyFor(channel, ts));
}

async function rememberThreadTs(channel, ts, threadTs) {
  await kv.set(keyFor(channel, ts), threadTs, { ex: TTL_SECONDS });
}

module.exports = { getExistingThreadTs, rememberThreadTs };
