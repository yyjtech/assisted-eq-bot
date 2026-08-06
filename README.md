# Assisted EQ Bot

A serverless Slack app that listens for a specific emoji reaction on any message and takes action when that emoji is added.

This app is built as a Vercel serverless function and uses Slack Events API `reaction_added` events.

## What it does

- listens for `reaction_added` events across channels the bot is in
- checks for a configured trigger emoji (defaults to `thermometer`)
- fetches the reacted-to message
- posts a notification into a target channel, threading follow-up reactions onto the same thread

## Files

- `api/slack/events.js` - Vercel function handling Slack event callbacks
- `lib/verify.js` - Slack request signature verification
- `lib/slack.js` - Slack Web API helpers
- `lib/store.js` - thread deduplication storage using Vercel KV
- `scripts/join-all-public-channels.js` - utility to join public channels so the bot receives events
- `slack-app-manifest.yml` - Slack app manifest for installation and event subscriptions

## Environment variables

Create a `.env` file or configure these in Vercel:

- `SLACK_BOT_TOKEN` - your bot token (xoxb...)
- `SLACK_SIGNING_SECRET` - Slack app signing secret
- `TRIAGE_CHANNEL_ID` - Slack channel ID where notifications should be posted

Optional:

- `TRIGGER_EMOJI` - emoji name to watch for (default: `thermometer`)
- `SPAM_EMOJI` - emoji name that screens a message for scam/spam signals instead of the EQ review (default: `spam`)
- `OPENAI_API_KEY` - API key for OpenAI to review flagged messages
- `ESCALATION_THRESHOLD` - minimum EQ score threshold for escalation (default: `6.5`)

## Slack app setup

1. Install the app into your workspace.
2. Give the bot these scopes:
   - `reactions:read`
   - `channels:history`
   - `groups:history`
   - `chat:write`
   - `channels:read`
   - `groups:read`
   - `channels:join`
3. Enable Event Subscriptions.
4. Set the Request URL to the deployed Vercel endpoint:
   - `https://<your-deployment>.vercel.app/api/slack/events`
5. Subscribe to the `reaction_added` bot event.

## Deployment

- Run locally with `npm run dev`
- Deploy with Vercel using the built-in Vercel integration or `vercel --prod`

## Useful command

If you want the bot to join every public channel automatically, run:

```bash
SLACK_BOT_TOKEN=xoxb-... node scripts/join-all-public-channels.js
```

## Notes

- Slack only delivers `reaction_added` events for channels the bot is a member of.
- The bot must already be invited to the configured channel.
- The user who adds the trigger emoji will receive a direct message confirming the message was forwarded to the Channel Stewards.
- The function acknowledges Slack quickly and does the Slack API work asynchronously for reliability.
