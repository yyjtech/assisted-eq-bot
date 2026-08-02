const { waitUntil } = require('@vercel/functions');
const { readRawBody, isValidSlackSignature } = require('../../lib/verify');
const { fetchMessage, getPermalink, postToTriage, sendDirectMessage } = require('../../lib/slack');
const { getExistingThreadTs, rememberThreadTs } = require('../../lib/store');
const { reviewMessage } = require('../../lib/openai');

// Vercel-specific: we need the exact raw bytes of the request body to verify
// Slack's signature, so we opt out of the platform's automatic body parsing.
module.exports.config = { api: { bodyParser: false } };

function blockquote(text) {
  return (text || '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

async function handleReactionAdded(event) {
  const triggerEmoji = process.env.TRIGGER_EMOJI || 'skunk';

  if (event.reaction !== triggerEmoji) return;
  if (!event.item || event.item.type !== 'message') return;

  const { channel, ts } = event.item;

  const [message, messagePermalink] = await Promise.all([
    fetchMessage(channel, ts),
    getPermalink(channel, ts),
  ]);

  if (!message) return; // message was deleted, or bot can't see the channel

  const author = message.user ? `<@${message.user}>` : 'someone';
  const messageText = message.text || '';
  const isSelfFlag = Boolean(message.user && event.user === message.user);

  if (isSelfFlag) {
    const aiReview = await reviewMessage(messageText).catch((err) => {
      console.error('Review failed', err);
      return null;
    });

    const feedbackText = [
      'Your message was reviewed by Assisted EQ Bot.',
      '',
      aiReview && aiReview.reviewText ? aiReview.reviewText : 'No review was generated.',
      '',
      `Original message: ${messagePermalink}`,
    ].join('\n');

    await sendDirectMessage(event.user, feedbackText);
    return;
  }

  const existingThreadTs = await getExistingThreadTs(channel, ts);
  if (existingThreadTs) {
    await postToTriage({
      text: `:${triggerEmoji}: Also flagged by <@${event.user}>`,
      threadTs: existingThreadTs,
    });
    return;
  }

  const aiReview = await reviewMessage(messageText).catch((err) => {
    console.error('OpenAI review failed', err);
    return null;
  });

  const textParts = [];
  if (aiReview && aiReview.needsEscalation) {
    textParts.push('@channel');
  }

  textParts.push(
    `:${triggerEmoji}: Flagged message from ${author} in <#${channel}>`,
    messagePermalink,
    blockquote(messageText)
  );

  if (aiReview && aiReview.reviewText) {
    textParts.push('\n*OpenAI review:*');
    textParts.push(aiReview.reviewText);
  }

  const posted = await postToTriage({ text: textParts.join('\n') });
  await rememberThreadTs(channel, ts, posted.ts);

  if (event.user) {
    try {
      await sendDirectMessage(
        event.user,
        `Your reaction has forwarded the message to the Channel Stewards. Thank you for helping keep this community as inclusive and safe as possible.`
      );
    } catch (err) {
      console.error('Failed to send DM to user', err);
    }
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const rawBody = await readRawBody(req);

  const valid = isValidSlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    timestamp: req.headers['x-slack-request-timestamp'],
    signature: req.headers['x-slack-signature'],
    rawBody,
  });

  if (!valid) {
    res.status(401).end();
    return;
  }

  const body = JSON.parse(rawBody.toString('utf8'));

  // One-time handshake Slack sends when you first set the Request URL.
  if (body.type === 'url_verification') {
    res.status(200).json({ challenge: body.challenge });
    return;
  }

  // Slack retries the webhook if it doesn't get a fast 200 (e.g. cold start
  // taking too long). Ack immediately on retries instead of redoing work.
  if (req.headers['x-slack-retry-num']) {
    res.status(200).end();
    return;
  }

  // Ack fast, then do the Slack API calls in the background. waitUntil keeps
  // the invocation alive after the response is sent. Errors are logged, not
  // surfaced to Slack, so a transient failure doesn't trigger a retry storm.
  res.status(200).end();

  if (body.type === 'event_callback' && body.event && body.event.type === 'reaction_added') {
    waitUntil(
      handleReactionAdded(body.event).catch((err) => {
        console.error('Failed to handle reaction_added event', err);
      })
    );
  }
};
