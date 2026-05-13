import Groq from 'groq-sdk';

let _groq: Groq | null = null;
function getGroq(): Groq {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY || 'MISSING' });
  return _groq;
}

const SYSTEM_PROMPT = `You are a helpful customer support AI. Respond ONLY with a JSON object using this exact shape:
{
  "message": "<your reply to the customer>",
  "confidence": <integer 1-10>,
  "topic": "<one of: billing | technical | account | general | complaint | praise>",
  "suggestedAction": "<one of: respond | escalate | resolve>",
  "effect": <null | "confetti">
}

Confidence guide:
  8-10  Clear, simple query you can answer confidently.
  6-7   Moderate complexity — answer but the human team may want to follow up.
  1-5   Sensitive, ambiguous, or complex — use suggestedAction "escalate".

Use suggestedAction "resolve" when the customer is clearly satisfied and the conversation is complete.
If the user says "thanks", "thank you", "perfect", "great", "got it", "all good", or similar
closing phrases, use suggestedAction "resolve" with confidence 9.
Use "confetti" effect only for genuinely happy resolutions.`;

export interface AIResult {
  message:         string;
  confidence:      number;
  topic:           string;
  suggestedAction: 'respond' | 'escalate' | 'resolve';
  effect:          string | null;
}

const FALLBACK: AIResult = {
  message:         "I'm sorry, I ran into an issue. Let me connect you with a human agent.",
  confidence:      1,
  topic:           'general',
  suggestedAction: 'escalate',
  effect:          null,
};

const VALID_TOPICS  = ['billing', 'technical', 'account', 'general', 'complaint', 'praise'];
const VALID_ACTIONS = ['respond', 'escalate', 'resolve'];

export async function generateAIResponse(
  history: Array<{ sender: string; content: string }>,
  userMessage: string,
): Promise<AIResult> {
  try {
    const messages: Groq.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map((m) => ({
        role:    (m.sender === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: m.content,
      })),
      { role: 'user', content: userMessage },
    ];

    const completion = await getGroq().chat.completions.create({
      model:           'llama-3.1-8b-instant',
      messages,
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0]?.message?.content ?? '{}';
    const p   = JSON.parse(raw);

    return {
      message: typeof p.message === 'string' && p.message ? p.message : FALLBACK.message,
      confidence:
        typeof p.confidence === 'number'
          ? Math.max(1, Math.min(10, Math.round(p.confidence)))
          : 1,
      topic:           VALID_TOPICS.includes(p.topic) ? p.topic : 'general',
      suggestedAction: VALID_ACTIONS.includes(p.suggestedAction)
        ? (p.suggestedAction as AIResult['suggestedAction'])
        : 'escalate',
      effect: p.effect === 'confetti' ? 'confetti' : null,
    };
  } catch {
    return FALLBACK;
  }
}
