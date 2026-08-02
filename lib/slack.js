const { WebClient } = require('@slack/web-api');

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

// Cached per warm lambda instance so we don't call conversations.list on
// every invocation. Cold starts pay for one lookup.
let cachedTriageChannelId = null;

async function resolveTriageChannelId() {
  if (cachedTriageChannelId) return cachedTriageChannelId;

  const channelId = process.env.TRIAGE_CHANNEL_ID;
  if (!channelId) {
    throw new Error('TRIAGE_CHANNEL_ID env var is not set');
  }

  cachedTriageChannelId = channelId;
  return cachedTriageChannelId;
}

function buildForwardedMessagePayload({ message, permalink, introText }) {
  const textParts = [];
  if (introText) {
    textParts.push(introText);
  }
  if (permalink) {
    textParts.push(permalink);
  }

  const messageText = message && message.text ? message.text : '';
  if (messageText) {
    textParts.push('');
    textParts.push(messageText);
  }

  return {
    text: textParts.join('\n'),
    attachments: Array.isArray(message && message.attachments) ? message.attachments : undefined,
    blocks: Array.isArray(message && message.blocks) ? message.blocks : undefined,
  };
}

// Fetches the single message that was reacted to.
async function fetchMessage(channel, ts) {
  const res = await client.conversations.history({
    channel,
    latest: ts,
    oldest: ts,
    inclusive: true,
    limit: 1,
  });

  return (res.messages && res.messages[0]) || null;
}

async function getPermalink(channel, ts) {
  const res = await client.chat.getPermalink({ channel, message_ts: ts });
  return res.permalink;
}

async function postToTriage({ text, threadTs, message, permalink, introText }) {
  const channel = await resolveTriageChannelId();
  const payload = buildForwardedMessagePayload({ message, permalink, introText });

  try {
    return await client.chat.postMessage({
      channel,
      text: text || payload.text,
      thread_ts: threadTs,
      unfurl_links: false,
      attachments: payload.attachments,
      blocks: payload.blocks,
    });
  } catch (err) {
    console.error('Failed to post to triage channel', {
      channel,
      error: err && err.data && err.data.error,
      message: err && err.message,
    });
    throw new Error(`Unable to post to triage channel ${channel}: ${err.message}`);
  }
}

async function sendDirectMessage(userId, text) {
  const res = await client.conversations.open({ users: userId });
  return client.chat.postMessage({
    channel: res.channel.id,
    text,
    unfurl_links: false,
  });
}

module.exports = {
  client,
  fetchMessage,
  getPermalink,
  postToTriage,
  sendDirectMessage,
  resolveTriageChannelId,
  buildForwardedMessagePayload,
};
