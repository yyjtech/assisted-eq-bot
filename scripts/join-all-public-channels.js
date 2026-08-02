// One-time (or periodic) setup script: makes the bot join every public
// channel it isn't already in, since Slack only delivers reaction_added
// events (and lets you read message text) for channels the bot is a member
// of. Private channels still need a manual /invite @YourBotName.
//
// Usage: SLACK_BOT_TOKEN=xoxb-... node scripts/join-all-public-channels.js
require('dotenv').config();
const { WebClient } = require('@slack/web-api');

const client = new WebClient(process.env.SLACK_BOT_TOKEN);

async function main() {
  let cursor;
  let joined = 0;
  let skipped = 0;

  do {
    const res = await client.conversations.list({
      types: 'public_channel',
      exclude_archived: true,
      limit: 200,
      cursor,
    });

    for (const channel of res.channels) {
      if (channel.is_member) {
        skipped += 1;
        continue;
      }
      try {
        await client.conversations.join({ channel: channel.id });
        console.log(`Joined #${channel.name}`);
        joined += 1;
      } catch (err) {
        console.error(`Could not join #${channel.name}: ${err.data ? err.data.error : err.message}`);
      }
    }

    cursor = res.response_metadata && res.response_metadata.next_cursor;
  } while (cursor);

  console.log(`Done. Joined ${joined} channel(s), already in ${skipped}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
