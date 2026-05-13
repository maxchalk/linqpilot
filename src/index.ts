import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response } from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import cors from 'cors';

import { db, stmts, convWithMessages, ConvRow, MsgRow } from './db.js';
import { linqSendMessage } from './linq.js';
import { createWebhookHandler } from './webhook.js';

const PORT = parseInt(process.env.PORT || '3001', 10);

// ---------------------------------------------------------------------------
// HTTP + WebSocket server
// ---------------------------------------------------------------------------
const app        = express();
const httpServer = createServer(app);
const wss        = new WebSocketServer({ server: httpServer });

function broadcast(data: object): void {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

// ---------------------------------------------------------------------------
// Middleware + routes
// ---------------------------------------------------------------------------
app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Webhook uses its own body parser (accepts any Content-Type from Linq)
app.post('/webhook', ...createWebhookHandler(broadcast));

// Standard JSON parser for all API routes below
app.use(express.json());

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------
app.get('/api/conversations', (_req: Request, res: Response) => {
  const convs = stmts.allConvs.all() as unknown as ConvRow[];
  res.json(
    convs.map((c) => ({ ...c, messages: stmts.msgs.all(c.chat_id) as unknown as MsgRow[] })),
  );
});

app.get('/api/analytics', (_req: Request, res: Response) => {
  const { count: total }    = db.prepare('SELECT COUNT(*) as count FROM conversations').get() as { count: number };
  const { count: resolved } = db.prepare("SELECT COUNT(*) as count FROM conversations WHERE status = 'resolved'").get() as { count: number };
  const { count: escalated }= db.prepare("SELECT COUNT(*) as count FROM conversations WHERE mode = 'human'").get() as { count: number };
  const { avg }             = db.prepare("SELECT AVG(confidence) as avg FROM conversations WHERE confidence > 0").get() as { avg: number | null };

  const topics = db.prepare(
    `SELECT topic, COUNT(*) as count FROM conversations
     WHERE topic IS NOT NULL GROUP BY topic ORDER BY count DESC LIMIT 6`,
  ).all() as Array<{ topic: string; count: number }>;

  res.json({
    total,
    resolved,
    escalated,
    resolutionRate:  total > 0 ? Math.round((resolved / total) * 100) : 0,
    avgConfidence:   Math.round((avg ?? 0) * 10) / 10,
    topics,
  });
});

app.post('/api/conversations/:chatId/message', async (req: Request, res: Response) => {
  const { chatId } = req.params;
  const { text }   = req.body as { text?: string };

  if (!text?.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  try {
    await linqSendMessage(chatId, text.trim());
    stmts.insertMsg.run(chatId, null, 'human_agent', text.trim(), null, null);
    stmts.touchConv.run(text.trim(), chatId);
    broadcast({ type: 'conversation_update', data: convWithMessages(chatId) });
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Failed to send message' });
  }
});

app.post('/api/conversations/:chatId/takeover', (req: Request, res: Response) => {
  const { chatId } = req.params;
  const conv = stmts.getConv.get(chatId) as unknown as ConvRow | undefined;
  if (!conv) { res.status(404).json({ error: 'Conversation not found' }); return; }

  const newMode   = conv.mode === 'ai' ? 'human' : 'ai';
  const newStatus = newMode === 'human' ? 'needs_attention' : 'active';
  stmts.setMode.run(newMode, newStatus, chatId);

  broadcast({ type: 'mode_change',         data: { chatId, mode: newMode, status: newStatus } });
  broadcast({ type: 'conversation_update', data: convWithMessages(chatId) });
  res.json({ ok: true, mode: newMode });
});

app.post('/api/conversations/:chatId/resolve', (req: Request, res: Response) => {
  const { chatId } = req.params;
  stmts.setStatus.run('resolved', chatId);
  broadcast({ type: 'conversation_update', data: convWithMessages(chatId) });
  res.json({ ok: true });
});

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// WebSocket — push initial state on connect
// ---------------------------------------------------------------------------
wss.on('connection', (ws: WebSocket) => {
  const convs = stmts.allConvs.all() as unknown as ConvRow[];
  ws.send(JSON.stringify({
    type: 'init',
    data: convs.map((c) => ({ ...c, messages: stmts.msgs.all(c.chat_id) as unknown as MsgRow[] })),
  }));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
httpServer.listen(PORT, () => {
  console.log(`\n✅  LinqPilot running → http://localhost:${PORT}\n`);
  if (!process.env.LINQ_API_TOKEN)    console.warn('⚠️  LINQ_API_TOKEN not set');
  if (!process.env.GROQ_API_KEY)      console.warn('⚠️  GROQ_API_KEY not set');
  if (!process.env.LINQ_WEBHOOK_SECRET) console.warn('⚠️  LINQ_WEBHOOK_SECRET not set – signature verification disabled');
});
