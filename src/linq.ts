const BASE = 'https://api.linqapp.com/api/partner/v3';

const WELCOME_IMAGE_URL =
  'https://images.unsplash.com/photo-1486312338219-ce68d2c6f44d?w=800&q=80';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function linqRequest(method: string, path: string, body?: any) {
  const token = process.env.LINQ_API_TOKEN?.trim();
  const url   = `${BASE}${path}`;

  const res = await fetch(url, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  return res;
}

export async function linqSendMessage(chatId: string, text: string, effect?: string): Promise<void> {
  const message: Record<string, unknown> = {
    parts: [{ type: 'text', value: text }],
  };

  if (effect) {
    console.log('[Linq] Sending confetti effect with message');
    message.effect = { type: 'screen', name: effect };
  }

  await linqRequest('POST', `/chats/${chatId}/messages`, {
    from:    process.env.LINQ_PHONE_NUMBER || '',
    chat_id: chatId,
    message,
  });
}

export async function linqSendWelcome(chatId: string): Promise<void> {
  const res = await linqRequest('POST', `/chats/${chatId}/messages`, {
    from:    process.env.LINQ_PHONE_NUMBER || '',
    chat_id: chatId,
    message: {
      parts: [
        { type: 'media', url: WELCOME_IMAGE_URL },
        { type: 'text',  value: '👋 Welcome! I\'m your AI support assistant. How can I help you today?' },
      ],
    },
  });
  console.log('[Linq] Welcome image sent:', res.status);
}

export async function linqStartTyping(chatId: string): Promise<void> {
  await linqRequest('POST', `/chats/${chatId}/typing`);
}

export async function linqStopTyping(chatId: string): Promise<void> {
  await linqRequest('DELETE', `/chats/${chatId}/typing`);
}

export async function linqAddReaction(messageId: string, type: string, emoji?: string): Promise<void> {
  const body: Record<string, string> = { operation: 'add', type };
  if (type === 'custom' && emoji) body.emoji = emoji;
  await linqRequest('POST', `/messages/${messageId}/reactions`, body);
}

export async function linqMarkRead(chatId: string): Promise<void> {
  await linqRequest('POST', `/chats/${chatId}/read`);
}
