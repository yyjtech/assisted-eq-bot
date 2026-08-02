const test = require('node:test');
const assert = require('node:assert/strict');
const { buildForwardedMessagePayload } = require('../lib/slack');
const { getExistingThreadTs, rememberThreadTs } = require('../lib/store');

async function withEnv(key, value, fn) {
  const previous = process.env[key];
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }

  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = previous;
    }
  }
}

test('builds a forwarded message payload that preserves body and attachments', () => {
  const payload = buildForwardedMessagePayload({
    message: {
      text: 'Hello world',
      attachments: [{ text: 'Attachment body' }],
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Block body' } }],
    },
    permalink: 'https://slack.example.com/message',
    introText: 'Forwarded message',
  });

  assert.match(payload.text, /Forwarded message/);
  assert.match(payload.text, /Hello world/);
  assert.match(payload.text, /https:\/\/slack\.example\.com\/message/);
  assert.deepStrictEqual(payload.attachments, [{ text: 'Attachment body' }]);
  assert.deepStrictEqual(payload.blocks, [{ type: 'section', text: { type: 'mrkdwn', text: 'Block body' } }]);
});

test('resolveTriageChannelId requires TRIAGE_CHANNEL_ID', async () => {
  const { resolveTriageChannelId } = require('../lib/slack');

  await assert.rejects(
    () => withEnv('TRIAGE_CHANNEL_ID', undefined, () => resolveTriageChannelId()),
    /TRIAGE_CHANNEL_ID env var is not set/
  );
});

test('resolveTriageChannelId returns the configured channel id', async () => {
  const { resolveTriageChannelId } = require('../lib/slack');

  await withEnv('TRIAGE_CHANNEL_ID', 'C123', async () => {
    assert.equal(await resolveTriageChannelId(), 'C123');
  });
});

test('falls back to in-memory deduplication when KV is unavailable', async () => {
  await rememberThreadTs('C123', '1700000000.0001', '1700000000.0002');
  assert.equal(await getExistingThreadTs('C123', '1700000000.0001'), '1700000000.0002');
});
