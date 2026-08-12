const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSlackBody, parseShortcutPayload, buildFeedbackText, buildUnavailableMessageText } = require('../api/slack/events');
const { buildForwardedMessagePayload, buildMessageFetchRequests } = require('../lib/slack');
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

test('parses URL-encoded Slack interaction payloads', () => {
  const rawBody = Buffer.from('payload=%7B%22type%22%3A%22shortcut%22%2C%22user%22%3A%7B%22id%22%3A%22U123%22%7D%2C%22channel%22%3A%7B%22id%22%3A%22C123%22%7D%2C%22message%22%3A%7B%22ts%22%3A%221700000000.0001%22%7D%7D');

  const parsed = parseSlackBody(rawBody);

  assert.equal(parsed.type, 'shortcut');
  assert.equal(parsed.user.id, 'U123');
  assert.equal(parsed.channel.id, 'C123');
  assert.equal(parsed.message.ts, '1700000000.0001');
});

test('parses Slack message_action payloads for message review', () => {
  const rawBody = Buffer.from('payload=%7B%22type%22%3A%22message_action%22%2C%22callback_id%22%3A%22review_message%22%2C%22user%22%3A%7B%22id%22%3A%22U456%22%7D%2C%22channel%22%3A%7B%22id%22%3A%22C456%22%7D%2C%22message%22%3A%7B%22ts%22%3A%221700000000.0002%22%2C%22text%22%3A%22hello%22%7D%7D');

  const parsed = parseSlackBody(rawBody);
  const parsedShortcut = parseShortcutPayload(parsed);

  assert.equal(parsed.type, 'message_action');
  assert.equal(parsed.callback_id, 'review_message');
  assert.equal(parsedShortcut.sourceType, 'message_action');
  assert.equal(parsedShortcut.userId, 'U456');
  assert.equal(parsedShortcut.channelId, 'C456');
  assert.equal(parsedShortcut.messageTs, '1700000000.0002');
  assert.equal(parsedShortcut.message.text, 'hello');
});

test('parses Slack message_action payloads for the spam report shortcut', () => {
  const rawBody = Buffer.from('payload=%7B%22type%22%3A%22message_action%22%2C%22callback_id%22%3A%22report_spam%22%2C%22user%22%3A%7B%22id%22%3A%22U789%22%7D%2C%22channel%22%3A%7B%22id%22%3A%22C789%22%7D%2C%22message%22%3A%7B%22ts%22%3A%221700000000.0003%22%2C%22text%22%3A%22buy%20now%22%7D%7D');

  const parsed = parseSlackBody(rawBody);
  const parsedShortcut = parseShortcutPayload(parsed);

  assert.equal(parsed.callback_id, 'report_spam');
  assert.equal(parsedShortcut.callbackId, 'report_spam');
  assert.equal(parsedShortcut.userId, 'U789');
  assert.equal(parsedShortcut.channelId, 'C789');
  assert.equal(parsedShortcut.messageTs, '1700000000.0003');
});

test('builds shared feedback text with the AI review and permalink', () => {
  const feedbackText = buildFeedbackText({
    messageText: 'hello world',
    aiReview: { reviewText: 'This is a review' },
    messagePermalink: 'https://slack.example.com/message',
  });

  assert.match(feedbackText, /Message was reviewed by Assisted EQ Bot\./);
  assert.match(feedbackText, /This is a review/);
  assert.match(feedbackText, /https:\/\/slack\.example\.com\/message/);
});

test('builds a fallback message text when the original message cannot be fetched', () => {
  const fallbackText = buildUnavailableMessageText({
    messagePermalink: 'https://slack.example.com/message',
    channelId: 'C123',
    triggerEmoji: 'thermometer',
    author: '<@U123>',
  });

  assert.match(fallbackText, /thermometer/);
  assert.match(fallbackText, /<@U123>/);
  assert.match(fallbackText, /https:\/\/slack\.example\.com\/message/);
  assert.match(fallbackText, /could not be retrieved/i);
});

test('builds both history and replies fetches for a message lookup', () => {
  const requests = buildMessageFetchRequests('C123', '1700000000.0001');

  assert.equal(requests[0].method, 'history');
  assert.deepStrictEqual(requests[0].params, {
    channel: 'C123',
    latest: '1700000000.0001',
    oldest: '1700000000.0001',
    inclusive: true,
    limit: 1,
  });

  assert.equal(requests[1].method, 'replies');
  assert.deepStrictEqual(requests[1].params, {
    channel: 'C123',
    ts: '1700000000.0001',
    inclusive: true,
    limit: 10,
  });
});

test('uses an explicit template text instead of rebuilding it from the message body', () => {
  const payload = buildForwardedMessagePayload({
    message: {
      text: 'Hello world',
      attachments: [{ text: 'Attachment body' }],
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Block body' } }],
    },
    permalink: 'https://slack.example.com/message',
    introText: 'Forwarded message',
    text: 'Template body from the handler',
  });

  assert.equal(payload.text, 'Template body from the handler');
  assert.equal(payload.attachments, undefined);
  assert.equal(payload.blocks, undefined);
});

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
