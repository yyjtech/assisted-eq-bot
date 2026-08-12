const { waitUntil } = require('@vercel/functions');
const { readRawBody, isValidSlackSignature } = require('../../lib/verify');
const { fetchMessage, getPermalink, postToTriage, sendDirectMessage } = require('../../lib/slack');
const { getExistingThreadTs, rememberThreadTs } = require('../../lib/store');
const { reviewMessage, reviewSpamMessage } = require('../../lib/openai');

// Vercel-specific: we need the exact raw bytes of the request body to verify
// Slack's signature, so we opt out of the platform's automatic body parsing.
module.exports.config = { api: { bodyParser: false } };

function blockquote(text) {
  return (text || '')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

function buildFeedbackText({ messageText, aiReview, messagePermalink }) {
  return [
    'Message was reviewed by Assisted EQ Bot.',
    '',
    aiReview && aiReview.reviewText ? aiReview.reviewText : 'No review was generated.',
    '',
    `>>> ${messageText}`,
    `Original message: ${messagePermalink}`,
  ].join('\n');
}

function buildSpamFeedbackText({ messageText, spamReview, messagePermalink }) {
  return [
    'Message was screened by Spam Watch.',
    '',
    spamReview && spamReview.reviewText ? spamReview.reviewText : 'No screening result was generated.',
    '',
    `>>> ${messageText}`,
    `Original message: ${messagePermalink}`,
  ].join('\n');
}

function buildUnavailableMessageText({ messagePermalink, channelId, triggerEmoji, author }) {
  return [
    `:${triggerEmoji}: Flagged message from ${author} in <#${channelId}>`,
    messagePermalink,
    '',
    'The original message could not be retrieved from Slack, but the review request was still recorded.',
  ].join('\n');
}

function decodeFormBody(bodyText) {
  const params = new URLSearchParams(bodyText);
  const payloadValue = params.get('payload');
  if (!payloadValue) return null;

  return JSON.parse(payloadValue);
}

function parseSlackBody(rawBody) {
  if (!rawBody) return {};

  const bodyText = rawBody.toString('utf8');
  if (!bodyText) return {};

  if (bodyText.startsWith('payload=')) {
    return decodeFormBody(bodyText);
  }

  return JSON.parse(bodyText);
}

// If the flagged message is a reply in a thread, fetch the original post that
// started the thread so the AI review has more context than the reply alone.
async function getThreadRootText(channelId, message) {
  if (!message || !message.thread_ts || message.thread_ts === message.ts) {
    return null;
  }

  const rootMessage = await fetchMessage(channelId, message.thread_ts);
  return rootMessage && rootMessage.text ? rootMessage.text : null;
}

function parseShortcutPayload(payload) {
  if (!payload || !['shortcut', 'message_action'].includes(payload.type)) return null;

  return {
    sourceType: payload.type === 'message_action' ? 'message_action' : 'shortcut',
    callbackId: payload.callback_id || null,
    userId: payload.user && payload.user.id,
    channelId: payload.channel && payload.channel.id,
    messageTs: payload.message && payload.message.ts,
    message: payload.message || null,
  };
}

async function handleMessageReview({ sourceType, userId, channelId, messageTs, triggerEmoji, reviewType = 'eq', anonymous = false, message: payloadMessage }) {
  if (!channelId || !messageTs) {
    console.log('Shortcut payload missing channel or message timestamp', { channelId, messageTs });
    return;
  }

  let message = payloadMessage || null;
  let messagePermalink = null;

  if (message) {
    console.log('Using message from interaction payload', { channel: channelId, ts: messageTs, messageUser: message.user });
    if (messageTs) {
      messagePermalink = await getPermalink(channelId, messageTs).catch((err) => {
        console.error('Failed to resolve permalink from payload message', err);
        return null;
      });
    }
  } else {
    console.log('Fetching message and permalink', { channel: channelId, ts: messageTs });
    [message, messagePermalink] = await Promise.all([
      fetchMessage(channelId, messageTs),
      getPermalink(channelId, messageTs),
    ]);
  }

  if (!message) {
    console.log('No message found for review target; likely deleted or inaccessible', { channel: channelId, ts: messageTs });
    return;
  }

  console.log('Fetched message', { channel: channelId, ts: messageTs, messageUser: message.user, messageText: message.text });

  const author = message.user ? `<@${message.user}>` : 'someone';
  const messageText = message.text || '';
  const isSelfFlag = Boolean(message.user && userId === message.user);
  const threadContext = await getThreadRootText(channelId, message);

  if (reviewType === 'eq' && isSelfFlag) {
    console.log('Self-flagging path selected', { author: message.user, anonymous, ...(anonymous ? {} : { user: userId }) });
    const aiReview = await reviewMessage(messageText, { threadContext }).catch((err) => {
      console.error('Review failed', err);
      return null;
    });

    const feedbackText = buildFeedbackText({
      messageText,
      aiReview,
      messagePermalink,
    });

    console.log('Sending feedback DM to self-flagging user', { anonymous, ...(anonymous ? {} : { user: userId }) });
    await sendDirectMessage(userId, feedbackText);
    console.log('Feedback DM sent');
    return;
  }

  const existingThreadTs = await getExistingThreadTs(channelId, messageTs);
  if (existingThreadTs) {
    console.log('Found existing thread for message; posting follow-up reply', { channel: channelId, ts: messageTs, existingThreadTs, anonymous });
    const followUpText = anonymous
      ? `:${triggerEmoji}: Also flagged (reported anonymously)`
      : `:${triggerEmoji}: Also flagged by <@${userId}>`;
    await postToTriage({
      text: followUpText,
      threadTs: existingThreadTs,
      message,
      permalink: messagePermalink,
      introText: followUpText,
    });
    console.log('Follow-up reply posted');
    return;
  }

  console.log('No existing thread found; generating new triage post', { reviewType });
  const aiReview = reviewType === 'spam'
    ? await reviewSpamMessage(messageText, { threadContext }).catch((err) => {
      console.error('OpenAI spam review failed', err);
      return null;
    })
    : await reviewMessage(messageText, { threadContext }).catch((err) => {
      console.error('OpenAI review failed', err);
      return null;
    });

  const feedbackText = reviewType === 'spam'
    ? buildSpamFeedbackText({ messageText, spamReview: aiReview, messagePermalink })
    : buildFeedbackText({ messageText, aiReview, messagePermalink });

  const textParts = [];


  textParts.push(
    `:${triggerEmoji}: Flagged message from ${author} in <#${channelId}>`,
    feedbackText
  );

  console.log('Posting triage message', { channel: channelId, ts: messageTs, escalation: Boolean(aiReview && aiReview.needsEscalation) });
  const posted = await postToTriage({
    text: textParts.join('\n'),
    message,
    permalink: messagePermalink,
  });
  console.log('Triage message posted', { postedTs: posted && posted.ts });
  await rememberThreadTs(channelId, messageTs, posted.ts);
  console.log('Thread mapping stored', { channel: channelId, ts: messageTs, postedTs: posted && posted.ts });

  if (userId) {
    try {
      const acknowledgementText = anonymous
        ? 'Your anonymous report has forwarded the message to the Channel Stewards. Your identity was not shared. Thank you for helping keep this community as inclusive and safe as possible.'
        : sourceType === 'shortcut'
          ? 'Your shortcut request has forwarded the message to the Channel Stewards. Thank you for helping keep this community as inclusive and safe as possible.'
          : 'Your reaction has forwarded the message to the Channel Stewards. Thank you for helping keep this community as inclusive and safe as possible.';

      console.log('Sending acknowledgement DM to user', { sourceType, anonymous, ...(anonymous ? {} : { user: userId }) });
      await sendDirectMessage(userId, acknowledgementText);
      console.log('Acknowledgement DM sent');
    } catch (err) {
      console.error('Failed to send DM to user', err);
    }
  }
}

async function handleReactionAdded(event) {
  const triggerEmoji = process.env.TRIGGER_EMOJI || 'thermometer';
  const spamEmoji = process.env.SPAM_EMOJI || 'spam';

  console.log('Received reaction event', {
    reaction: event.reaction,
    triggerEmoji,
    spamEmoji,
    user: event.user,
    itemType: event.item && event.item.type,
    channel: event.item && event.item.channel,
    ts: event.item && event.item.ts,
  });

  const isReviewFlag = event.reaction === triggerEmoji;
  const isSpamFlag = event.reaction === spamEmoji;

  if (!isReviewFlag && !isSpamFlag) {
    console.log('Reaction did not match a trigger emoji');
    return;
  }

  if (!event.item || event.item.type !== 'message') {
    console.log('Reaction item was not a message');
    return;
  }

  const { channel, ts } = event.item;

  console.log('Fetching message and permalink', { channel, ts });
  const [message, messagePermalink] = await Promise.all([
    fetchMessage(channel, ts),
    getPermalink(channel, ts),
  ]);

  const author = message && message.user ? `<@${message.user}>` : 'someone';
  const messageText = message && message.text ? message.text : '';

  if (!message) {
    console.log('No message found for reaction; likely deleted or inaccessible', { channel, ts });

    const fallbackText = buildUnavailableMessageText({
      messagePermalink: messagePermalink || 'Unavailable',
      channelId: channel,
      triggerEmoji: event.reaction,
      author,
    });

    const posted = await postToTriage({ text: fallbackText });
    console.log('Posted fallback triage message for inaccessible reaction target', { postedTs: posted && posted.ts });
    await rememberThreadTs(channel, ts, posted.ts);
    return;
  }

  console.log('Fetched message', { channel, ts, messageUser: message.user, messageText: message.text });
  const isSelfFlag = Boolean(message.user && event.user === message.user);

  if (isReviewFlag && isSelfFlag) {
    console.log('Self-flagging path selected', { user: event.user, author: message.user });
    const threadContext = await getThreadRootText(channel, message);
    const aiReview = await reviewMessage(messageText, { threadContext }).catch((err) => {
      console.error('Review failed', err);
      return null;
    });

    console.log('AI review generated for self-flag', { reviewPresent: Boolean(aiReview && aiReview.reviewText) });

    const feedbackText = buildFeedbackText({
      messageText,
      aiReview,
      messagePermalink,
    });

    console.log('Sending feedback DM to self-flagging user', { user: event.user });
    await sendDirectMessage(event.user, feedbackText);
    console.log('Feedback DM sent');
    return;
  }

  const existingThreadTs = await getExistingThreadTs(channel, ts);
  if (existingThreadTs) {
    console.log('Found existing thread for message; posting follow-up reply', { channel, ts, existingThreadTs });
    await postToTriage({
      text: `:${event.reaction}: Also flagged by <@${event.user}>`,
      threadTs: existingThreadTs,
    });
    console.log('Follow-up reply posted');
    return;
  }

  const threadContext = await getThreadRootText(channel, message);
  let feedbackText = null;
  let aiReview = null;

  if (isReviewFlag) {
    console.log('No existing thread found; generating new triage post with AI review');
    aiReview = await reviewMessage(messageText, { threadContext }).catch((err) => {
      console.error('OpenAI review failed', err);
      return null;
    });

    feedbackText = buildFeedbackText({
      messageText,
      aiReview,
      messagePermalink,
    });
  } else {
    console.log('No existing thread found; generating new triage post with spam review', { reaction: event.reaction });
    aiReview = await reviewSpamMessage(messageText, { threadContext }).catch((err) => {
      console.error('OpenAI spam review failed', err);
      return null;
    });

    feedbackText = buildSpamFeedbackText({
      messageText,
      spamReview: aiReview,
      messagePermalink,
    });
  }

  const textParts = [];
  textParts.push(`:${event.reaction}: Flagged message from ${author} in <#${channel}>`);
  if (feedbackText) {
    textParts.push(feedbackText);
  }

  console.log('Posting triage message', { channel, ts, escalation: Boolean(aiReview && aiReview.needsEscalation), reviewType: isReviewFlag ? 'eq' : 'spam' });
  const posted = await postToTriage({ text: textParts.join('\n') });
  console.log('Triage message posted', { postedTs: posted && posted.ts });
  await rememberThreadTs(channel, ts, posted.ts);
  console.log('Thread mapping stored', { channel, ts, postedTs: posted && posted.ts });

  if (event.user) {
    try {
      console.log('Sending acknowledgement DM to reacting user', { user: event.user });
      await sendDirectMessage(
        event.user,
        `Your reaction has forwarded the message to the Channel Stewards. Thank you for helping keep this community as inclusive and safe as possible.`
      );
      console.log('Acknowledgement DM sent');
    } catch (err) {
      console.error('Failed to send DM to user', err);
    }
  }
}

async function handler(req, res) {
  console.log('Incoming request', { method: req.method, url: req.url });

  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  const rawBody = await readRawBody(req);
  console.log('Raw body received', { length: rawBody.length, headers: {
    slackTimestamp: req.headers['x-slack-request-timestamp'],
    slackSignature: Boolean(req.headers['x-slack-signature']),
    slackRetry: req.headers['x-slack-retry-num'],
  }});

  const valid = isValidSlackSignature({
    signingSecret: process.env.SLACK_SIGNING_SECRET,
    timestamp: req.headers['x-slack-request-timestamp'],
    signature: req.headers['x-slack-signature'],
    rawBody,
  });

  console.log('Signature validation result', { valid });
  if (!valid) {
    res.status(401).end();
    return;
  }

  const body = parseSlackBody(rawBody);
  console.log('Parsed request body', {
    type: body.type,
    eventType: body.event && body.event.type,
    challenge: body.type === 'url_verification',
  });

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

  if (body.type === 'shortcut' || body.type === 'message_action') {
    const shortcutPayload = parseShortcutPayload(body);
    const triggerEmoji = process.env.TRIGGER_EMOJI || 'thermometer';
    const spamEmoji = process.env.SPAM_EMOJI || 'spam';

    if (shortcutPayload) {
      const isSpamShortcut = shortcutPayload.callbackId === 'report_spam';
      const isAnonymousCocShortcut = shortcutPayload.callbackId === 'report_coc_anonymous';

      waitUntil(
        handleMessageReview({
          ...shortcutPayload,
          triggerEmoji: isSpamShortcut ? spamEmoji : triggerEmoji,
          reviewType: isSpamShortcut ? 'spam' : 'eq',
          anonymous: isAnonymousCocShortcut,
        }).catch((err) => {
          console.error('Failed to handle shortcut payload', err);
        })
      );
    }
  }
}

handler.parseSlackBody = parseSlackBody;
handler.parseShortcutPayload = parseShortcutPayload;
handler.buildFeedbackText = buildFeedbackText;
handler.buildUnavailableMessageText = buildUnavailableMessageText;
module.exports = handler;
