const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

function parseScoreSummary(reviewText) {
  if (!reviewText) return null;

  const threshold = Number(process.env.ESCALATION_THRESHOLD || '6.5');

  const categoryPatterns = [
    { key: 'Curiosity', label: 'Curiosity' },
    { key: 'Integrity', label: 'Integrity' },
    { key: 'Kindness', label: 'Kindness' },
    { key: 'Psychological safety', label: 'Psychological safety' },
  ];

  const scores = {};

  for (const { key, label } of categoryPatterns) {
    const match = reviewText.match(new RegExp(`${label}\\s*[:\\-]\\s*(\\d+(?:\\.\\d+)?)\\s*(?:\\/|out of)\\s*10`, 'i'));
    if (match) {
      scores[key] = Number(match[1]);
    }
  }

  const values = Object.values(scores);
  if (!values.length) return null;

  const averageScore = values.reduce((sum, value) => sum + value, 0) / values.length;
  const needsEscalation = values.some((value) => value < threshold) || averageScore < threshold;

  return {
    reviewText,
    scores,
    averageScore,
    needsEscalation,
  };
}

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

  const reviewText = data.choices?.[0]?.message?.content?.trim() || null;
  return parseScoreSummary(reviewText) || { reviewText, scores: {}, averageScore: null, needsEscalation: false };
}

module.exports = { reviewMessage };
