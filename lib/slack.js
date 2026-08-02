const { WebClient } = require('@slack/web-api');

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

// Cached per warm lambda instance so we don't call conversations.list on
// every invocation. Cold starts pay for one lookup.
let cachedTriageChannelId = null;

async function resolveTriageChannelId() {
  if (cachedTriageChannelId) return cachedTriageChannelId;

  if (process.env.TRIAGE_CHANNEL_ID) {
    cachedTriageChannelId = process.env.TRIAGE_CHANNEL_ID;
    return cachedTriageChannelId;
  }

  const targetName = process.env.TRIAGE_CHANNEL_NAME;
  if (!targetName) {
    throw new Error('TRIAGE_CHANNEL_NAME or TRIAGE_CHANNEL_ID env var is not set');
  }

  let cursor;
  do {
    const res = await client.conversations.list({
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });

    const match = res.channels.find((c) => c.name === targetName);
    if (match) {
      cachedTriageChannelId = match.id;
      return cachedTriageChannelId;
    }

    cursor = res.response_metadata && res.response_metadata.next_cursor;
  } while (cursor);

  throw new Error(
    `Could not find a channel named "#${targetName}" that this bot is a member of. ` +
      'Double check the name and make sure the bot has been invited to it.'
  );
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

async function postToTriage({ text, threadTs }) {
  const channel = await resolveTriageChannelId();
  return client.chat.postMessage({
    channel,
    text,
    thread_ts: threadTs,
    unfurl_links: false,
  });
}

module.exports = { client, fetchMessage, getPermalink, postToTriage };
