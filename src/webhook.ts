import express, { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import { stmts, convWithMessages, ConvRow, MsgRow } from './db.js';
import {
  linqMarkRead,
  linqStartTyping,
  linqStopTyping,
  linqAddReaction,
  linqSendMessage,
  linqSendWelcome,
} from './linq.js';
import { generateAIResponse } from './ai.js';

// Augment Express Request to carry the raw body string for HMAC verification.
declare global {
  namespace Express {
    interface Request {
      rawBody?: string;
    }
  }
}

// Parses the raw Buffer from express.raw() into req.body (JSON) and
// stores the original string in req.rawBody for signature verification.
export function parseWebhookBody(req: Request, _res: Response, next: NextFunction): void {
  const raw = Buffer.isBuffer(req.body) ? req.body.toString() : '';
  req.rawBody = raw;
  try {
    req.body = JSON.parse(raw);
  } catch {
    req.body = {};
  }
  next();
}

export function createWebhookHandler(
  broadcast: (data: object) => void,
): express.RequestHandler[] {
  const handler: express.RequestHandler = (req: Request, res: Response) => {
    try {
      // HMAC-SHA256 signature verification
      const sig = req.headers['x-webhook-signature'] as string | undefined;
      const ts  = req.headers['x-webhook-timestamp']  as string | undefined;

      if (process.env.LINQ_WEBHOOK_SECRET && sig && ts) {
        const raw      = req.rawBody ?? '';
        const expected = crypto
          .createHmac('sha256', process.env.LINQ_WEBHOOK_SECRET)
          .update(`${ts}.${raw}`)
          .digest('hex');
        if (sig !== expected) {
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }
      }

      // Linq v3 webhook shape
      const event = req.body as {
        event_type?: string;
        data?: {
          id?:             string;                              // message ID (for reactions)
          parts?:          Array<{ type: string; value: string }>; // message body
          sender_handle?:  { handle?: string };                // sender phone
          chat?:           { id?: string };                    // conversation ID
        };
      };

      console.log('[Webhook] Received:', event.event_type ?? '(no event_type)');

      if (event.event_type !== 'message.received') {
        res.status(200).json({ ok: true });
        return;
      }

      const data        = event.data ?? {};
      const chatId      = data.chat?.id ?? '';
      const from        = data.sender_handle?.handle ?? chatId;
      const messageId   = data.id;
      const messageText = data.parts?.find((p) => p.type === 'text')?.value ?? '';

      console.log('[Webhook] Processing message from', from);

      if (!chatId || !messageText) {
        res.status(400).json({ error: 'Missing chatId or message text' });
        return;
      }

      // Upsert conversation
      const existing = stmts.getConv.get(chatId) as ConvRow | undefined;
      if (!existing) {
        stmts.insertConv.run(chatId, from, messageText);
      } else {
        stmts.touchConv.run(messageText, chatId);
      }

      stmts.insertMsg.run(chatId, messageId ?? null, 'user', messageText, null, null);

      const conv = stmts.getConv.get(chatId) as unknown as ConvRow;

      // Acknowledge immediately so Linq doesn't time out
      res.status(200).json({ ok: true });
      broadcast({ type: 'conversation_update', data: convWithMessages(chatId) });

      if (conv.mode === 'human') return;

      // Run AI pipeline asynchronously after the 200 is sent
      setImmediate(async () => {
        try {
          // Send welcome image once to first-time visitors, then stop —
          // the welcome message already contains the greeting, no AI reply needed.
          if (!conv.welcomed) {
            await linqSendWelcome(chatId).catch(() => {});
            stmts.setWelcomed.run(chatId);
            return;
          }

          await linqMarkRead(chatId).catch(() => {});
          await linqStartTyping(chatId).catch(() => {});
          if (messageId) await linqAddReaction(messageId, 'emphasize').catch(() => {});

          const rows    = (stmts.recentMsgs.all(chatId) as unknown as MsgRow[]).reverse();
          const history = rows.slice(0, -1).map((r) => ({ sender: r.sender, content: r.content }));

          const ai = await generateAIResponse(history, messageText);
          console.log('[Webhook] AI response: confidence', ai.confidence, '| action:', ai.suggestedAction);

          await linqStopTyping(chatId).catch(() => {});

          const shouldEscalate = ai.confidence < 6 || ai.suggestedAction === 'escalate';

          if (shouldEscalate) {
            stmts.setMode.run('human', 'needs_attention', chatId);
            if (messageId) await linqAddReaction(messageId, 'emphasize').catch(() => {});
            broadcast({ type: 'mode_change',         data: { chatId, mode: 'human', status: 'needs_attention' } });
            broadcast({ type: 'conversation_update', data: convWithMessages(chatId) });
            return;
          }

          // Confetti only when resolving with high confidence
          const effect = ai.suggestedAction === 'resolve' && ai.confidence >= 8
            ? 'confetti'
            : undefined;

          await linqSendMessage(chatId, ai.message, effect).catch(() => {});
          if (messageId) await linqAddReaction(messageId, 'like').catch(() => {});

          stmts.insertMsg.run(chatId, null, 'ai', ai.message, ai.confidence, ai.topic);

          if (ai.suggestedAction === 'resolve') {
            stmts.updateConvFull.run('resolved', 'ai', ai.confidence, ai.topic, ai.message, chatId);
          } else {
            stmts.updateConvFull.run('active', 'ai', ai.confidence, ai.topic, ai.message, chatId);
          }

          broadcast({ type: 'conversation_update', data: convWithMessages(chatId) });
          console.log('[Webhook] Done!');
        } catch {
          linqStopTyping(chatId).catch(() => {});
        }
      });
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    }
  };

  return [
    express.raw({ type: '*/*' }) as express.RequestHandler,
    parseWebhookBody,
    handler,
  ];
}
