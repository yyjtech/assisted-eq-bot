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

function parseSpamReviewSummary(reviewText) {
  if (!reviewText) return null;

  const threshold = Number(process.env.SPAM_ESCALATION_THRESHOLD || '4');

  const scoreMatch = reviewText.match(/Suspicion score\s*[:\-]\s*(\d+(?:\.\d+)?)\s*(?:\/|out of)\s*5/i);
  if (!scoreMatch) return null;

  const suspicionScore = Number(scoreMatch[1]);
  const signalsMatch = reviewText.match(/Signals present\s*[:\-]\s*(.+)/i);
  const signals = signalsMatch
    ? signalsMatch[1].split(',').map((signal) => signal.trim()).filter(Boolean)
    : [];

  return {
    reviewText,
    suspicionScore,
    signals,
    needsEscalation: suspicionScore >= threshold,
  };
}

async function reviewSpamMessage(messageText, { threadContext } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY env var is not set');
  }

  const threadContextBlock = threadContext
    ? `\n\nThe message below was posted as a reply in a Slack thread. Here is the original message that started the thread, included for context only — do not score it:\n"""\n${threadContext}\n"""`
    : '';

  const prompt = `Rate this message's suspicion level from 1 (clearly legitimate) to 5 (clearly a scam), based on the following signals. Note which signals are present and explain the score.

Identity and verification red flags
- No verifiable company name, agency name, or portfolio
- Generic professional buzzwords used to sound credible without substance
- Sender uses a name/backstory but nothing checkable (no LinkedIn, no company site, no references)

The core ask
- Requires the recipient to be based in a specific country/region for reasons unrelated to the actual work
- Asks the recipient to be the "face" of a business: taking meetings, interviews, or handling payments while someone else does the real work
- The recipient's role is disproportionately easy compared to the payoff offered (attend meetings, forward messages, "light commitment")

Compensation framing
- Vague compensation ("competitive pay," "extra income") with no real numbers
- Or, oddly generous and specific numbers (revenue splits, "10+ jobs guaranteed") designed to trigger greed
- Framed as effortless side income "without leaving your day job"

Contact and channel behavior
- Pushes toward DM or off-platform contact (Telegram, WhatsApp) instead of staying in the open channel
- Cold, mass-postable phrasing not tailored to this specific group
- Identical or near-identical text posted more than once (check message history for duplicates)

For job postings specifically
- Detailed, plausible job description (may be lifted from a real posting) paired with a broken or missing normal application process
- No recruiter name, no ATS link, no company careers page, just "DM me to apply"

Scoring guidance
- 0-1 signals present: likely legitimate, score 1-2
- 2-3 signals present: worth scrutiny, score 3
- 4+ signals present, especially identity-as-front ask plus DM push: score 4-5

Respond in exactly this format:
Suspicion score: X/5
Signals present: <comma-separated list, or "none">
Explanation: <one or two sentences>${threadContextBlock}

Message:
${messageText}`;

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
          content: 'You are a trust-and-safety reviewer that screens Slack messages for scam and spam signals, especially fraudulent job or income opportunities.',
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      temperature: 0.2,
      max_tokens: 200,
    }),
  });

  const data = await response.json();
  if (!response.ok) {
    const errorMessage = data.error?.message || response.statusText;
    throw new Error(`OpenAI request failed: ${errorMessage}`);
  }

  const reviewText = data.choices?.[0]?.message?.content?.trim() || null;
  return parseSpamReviewSummary(reviewText) || { reviewText, suspicionScore: null, signals: [], needsEscalation: false };
}

async function reviewMessage(messageText, { threadContext } = {}) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY env var is not set');
  }

  const threadContextBlock = threadContext
    ? `\n\nThe message below was posted as a reply in a Slack thread. Here is the original message that started the thread, included for context only — do not score it:\n"""\n${threadContext}\n"""`
    : '';

  const prompt = `
    Check to see if the message overall has a positive or neutral tone. If it has a negative tone, provide a score for each of the following categories on a scale of 1-10 (1 being the worst, 10 being the best). If the message is positive or neutral, do not provide any scores or give any feedback and instead respond with "This message seems to have a positive or neutral tone.".

    Curiosity: score out of 10
    Integrity: score out of 10
    Kindness: score out of 10
    Psychological safety: score out of 10

    Then give feedback on if the response fosters an inclusive community and suggest a new version with some minor edits, but in the same tone of voice to the original response to make it score higher.${threadContextBlock} \n\nMessage:\n${messageText}`;

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
          content: 'You are a Canadian communication coach that reviews Slack messages and provides feedback on communication quality in alignment with the slack community guidelines. The three tenants our expected behaviour are: behave as if you are in a professional event, Use kindness to build community, Be curious to hear about the other person’s perspective and We all have to help to foster safer and braver spaces.',
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

module.exports = { reviewMessage, reviewSpamMessage };
