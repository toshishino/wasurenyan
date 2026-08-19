import { DatabaseSync } from 'node:sqlite';

const dbFilename =
  process.env.NODE_ENV === 'production' ? 'reminders.production.db' : 'reminders.db';

const db = new DatabaseSync(dbFilename);

db.exec(`
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    content TEXT NOT NULL,
    recurrence_type TEXT NOT NULL CHECK (recurrence_type IN ('once', 'daily', 'weekly')),
    recurrence_value TEXT,
    time_of_day TEXT NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
    next_trigger_at INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    mention_targets TEXT NOT NULL DEFAULT '[]'
  );

  CREATE INDEX IF NOT EXISTS idx_reminders_due
    ON reminders (active, next_trigger_at);
`);

const hasMentionTargetsColumn = db
  .prepare(`PRAGMA table_info(reminders)`)
  .all()
  .some((col) => col.name === 'mention_targets');

if (!hasMentionTargetsColumn) {
  db.exec(`ALTER TABLE reminders ADD COLUMN mention_targets TEXT NOT NULL DEFAULT '[]'`);
}

export function insertReminder({
  guildId,
  channelId,
  userId,
  content,
  recurrenceType,
  recurrenceValue,
  timeOfDay,
  timezone,
  nextTriggerAt,
  mentionTargets,
}) {
  const stmt = db.prepare(`
    INSERT INTO reminders
      (guild_id, channel_id, user_id, content, recurrence_type, recurrence_value,
       time_of_day, timezone, next_trigger_at, active, created_at, mention_targets)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  const result = stmt.run(
    guildId,
    channelId,
    userId,
    content,
    recurrenceType,
    recurrenceValue ?? null,
    timeOfDay,
    timezone,
    nextTriggerAt,
    Math.floor(Date.now() / 1000),
    JSON.stringify(mentionTargets ?? [])
  );
  return Number(result.lastInsertRowid);
}

export function listRemindersByUser(guildId, userId) {
  const stmt = db.prepare(`
    SELECT id, content, recurrence_type, recurrence_value, time_of_day, next_trigger_at
    FROM reminders
    WHERE guild_id = ? AND user_id = ? AND active = 1
    ORDER BY next_trigger_at ASC
  `);
  return stmt.all(guildId, userId);
}

export function deleteReminderByOwner(id, userId) {
  const stmt = db.prepare(`
    DELETE FROM reminders WHERE id = ? AND user_id = ?
  `);
  const result = stmt.run(id, userId);
  return result.changes > 0;
}

export function getDueReminders(nowUnix) {
  const stmt = db.prepare(`
    SELECT * FROM reminders WHERE active = 1 AND next_trigger_at <= ?
  `);
  return stmt.all(nowUnix);
}

export function deactivateReminder(id) {
  db.prepare(`UPDATE reminders SET active = 0 WHERE id = ?`).run(id);
}

export function updateNextTrigger(id, nextTriggerAt) {
  db.prepare(`UPDATE reminders SET next_trigger_at = ? WHERE id = ?`).run(
    nextTriggerAt,
    id
  );
}

export default db;
