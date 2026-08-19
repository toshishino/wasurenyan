import cron from 'node-cron';
import {
  getDueReminders,
  deactivateReminder,
  updateNextTrigger,
} from './db.js';
import { computeFollowingTriggerAt } from './datetime.js';

export function startScheduler(client) {
  cron.schedule('* * * * *', () => checkAndFireReminders(client));
}

async function checkAndFireReminders(client) {
  const nowUnix = Math.floor(Date.now() / 1000);
  const due = getDueReminders(nowUnix);

  for (const reminder of due) {
    await fireReminder(client, reminder);
  }
}

async function fireReminder(client, reminder) {
  try {
    const channel = await client.channels.fetch(reminder.channel_id);
    if (channel && channel.isTextBased()) {
      await channel.send(
        `🐾 <@${reminder.user_id}> リマインド: ${reminder.content}`
      );
    }
  } catch (err) {
    console.error(
      `[scheduler] リマインド#${reminder.id}の送信に失敗しました:`,
      err
    );
  }

  if (reminder.recurrence_type === 'once') {
    deactivateReminder(reminder.id);
    return;
  }

  const nextTriggerAt = computeFollowingTriggerAt(
    reminder.recurrence_type,
    reminder.next_trigger_at
  );
  updateNextTrigger(reminder.id, nextTriggerAt);
}
