import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('linqpilot.db');

db.exec(`PRAGMA journal_mode = WAL`);

db.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    chat_id         TEXT PRIMARY KEY,
    phone_number    TEXT,
    status          TEXT NOT NULL DEFAULT 'active',
    mode            TEXT NOT NULL DEFAULT 'ai',
    last_message    TEXT,
    last_message_at TEXT,
    confidence      REAL DEFAULT 0,
    topic           TEXT DEFAULT 'general',
    welcomed        INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id     TEXT NOT NULL,
    message_id  TEXT,
    sender      TEXT NOT NULL,
    content     TEXT NOT NULL,
    confidence  REAL,
    topic       TEXT,
    created_at  TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (chat_id) REFERENCES conversations(chat_id)
  );
`);

// Migrate existing databases that predate the welcomed column
try {
  db.exec(`ALTER TABLE conversations ADD COLUMN welcomed INTEGER NOT NULL DEFAULT 0`);
} catch { /* column already exists */ }

export const stmts = {
  getConv: db.prepare('SELECT * FROM conversations WHERE chat_id = ?'),
  insertConv: db.prepare(
    `INSERT INTO conversations (chat_id, phone_number, last_message, last_message_at)
     VALUES (?, ?, ?, datetime('now'))`
  ),
  touchConv: db.prepare(
    `UPDATE conversations SET last_message = ?, last_message_at = datetime('now') WHERE chat_id = ?`
  ),
  updateConvFull: db.prepare(
    `UPDATE conversations
     SET status = ?, mode = ?, confidence = ?, topic = ?, last_message = ?, last_message_at = datetime('now')
     WHERE chat_id = ?`
  ),
  setStatus: db.prepare(`UPDATE conversations SET status = ? WHERE chat_id = ?`),
  setMode:   db.prepare(`UPDATE conversations SET mode = ?, status = ? WHERE chat_id = ?`),
  insertMsg: db.prepare(
    `INSERT INTO messages (chat_id, message_id, sender, content, confidence, topic)
     VALUES (?, ?, ?, ?, ?, ?)`
  ),
  setWelcomed: db.prepare(`UPDATE conversations SET welcomed = 1 WHERE chat_id = ?`),
  allConvs:   db.prepare('SELECT * FROM conversations ORDER BY last_message_at DESC'),
  msgs:       db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC'),
  recentMsgs: db.prepare('SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at DESC LIMIT 20'),
};

export interface ConvRow {
  chat_id:         string;
  phone_number:    string;
  status:          string;
  mode:            string;
  last_message:    string | null;
  last_message_at: string | null;
  confidence:      number;
  topic:           string;
  welcomed:        number;   // 0 = not yet welcomed, 1 = welcome sent
  created_at:      string;
}

export interface MsgRow {
  id:         number;
  chat_id:    string;
  message_id: string | null;
  sender:     string;
  content:    string;
  confidence: number | null;
  topic:      string | null;
  created_at: string;
}

export function convWithMessages(chatId: string): (ConvRow & { messages: MsgRow[] }) | null {
  const conv = stmts.getConv.get(chatId) as unknown as ConvRow | undefined;
  if (!conv) return null;
  return { ...conv, messages: stmts.msgs.all(chatId) as unknown as MsgRow[] };
}

export { db };
