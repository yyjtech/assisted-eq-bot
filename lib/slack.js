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

function buildForwardedMessagePayload({ message, permalink, introText, text }) {
  if (text) {
    return {
      text,
      attachments: undefined,
      blocks: undefined,
    };
  }

  const textParts = [];
  if (introText) {
    textParts.push(introText);
  }
  if (permalink) {
    textParts.push(permalink);
  }

  const messageText = message && message.text ? message.text : '';
  if (messageText && !introText) {
    textParts.push(messageText);
  } else if (messageText && introText) {
    textParts.push('');
    textParts.push(messageText);
  }

  return {
    text: textParts.join('\n'),
    attachments: Array.isArray(message && message.attachments) ? message.attachments : undefined,
    blocks: Array.isArray(message && message.blocks) ? message.blocks : undefined,
  };
}

function buildMessageFetchRequests(channel, ts) {
  return [
    {
      method: 'history',
      params: {
        channel,
        latest: ts,
        oldest: ts,
        inclusive: true,
        limit: 1,
      },
    },
    {
      method: 'replies',
      params: {
        channel,
        ts,
        inclusive: true,
        limit: 10,
      },
    },
  ];
}

// Fetches the single message that was reacted to.
async function fetchMessage(channel, ts) {
  for (const request of buildMessageFetchRequests(channel, ts)) {
    try {
      const res = request.method === 'history'
        ? await client.conversations.history(request.params)
        : await client.conversations.replies(request.params);

      const messages = res.messages || [];
      const match = messages.find((message) => message.ts === ts) || messages[0] || null;
      if (match) {
        return match;
      }
    } catch (err) {
      console.error(`Failed to fetch message via ${request.method}`, {
        channel,
        ts,
        error: err && err.data && err.data.error,
        message: err && err.message,
      });
    }
  }

  return null;
}

async function getPermalink(channel, ts) {
  const res = await client.chat.getPermalink({ channel, message_ts: ts });
  return res.permalink;
}

async function postToTriage({ text, threadTs, message, permalink, introText }) {
  const channel = await resolveTriageChannelId();
  const payload = buildForwardedMessagePayload({ message, permalink, introText, text });
  const bodyText = payload.text;

  try {
    return await client.chat.postMessage({
      channel,
      text: bodyText,
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
  buildMessageFetchRequests,
};
