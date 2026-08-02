const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

async function reviewMessage(messageText) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY env var is not set');
  }

  const prompt = `
    Rate the message in this format:
    Curiosity: score out of 10
    Integrity: score out of 10
    Kindness: score out of 10
    Psychological safety: score out of 10

    Then give feedback on if the response fosters an inclusive community and suggest a new version with some minor edits, but in the same tone of voice to the original response to make it score higher. \n\nMessage:\n${messageText}`;

  const response = await fetch(OPENAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: 'You are a Canadian communication coach that reviews Slack messages and provides feedback on communication quality in alignment with the slack community guidelines.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.4,
      max_tokens: 180,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const errorMessage = data.error?.message || response.statusText;
    throw new Error(`OpenAI request failed: ${errorMessage}`);
  }

  return data.choices?.[0]?.message?.content?.trim() || null;
}

module.exports = { reviewMessage };
