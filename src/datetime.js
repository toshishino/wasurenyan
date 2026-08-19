import * as chrono from 'chrono-node';

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'];
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseReminderDateTime(text, now = new Date()) {
  const results = chrono.ja.parse(text, now, { forwardDate: true });
  if (results.length === 0) return null;

  const date = results[0].start.date();
  return {
    date,
    weekday: date.getDay(),
    timeOfDay: formatTimeOfDay(date),
  };
}

export function formatTimeOfDay(date) {
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatDateTimeJa(date) {
  return new Intl.DateTimeFormat('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    weekday: 'short',
    hour12: false,
  }).format(date);
}

export function weekdayLabel(day) {
  return `${WEEKDAY_LABELS[day]}曜`;
}

export function recurrenceLabel(recurrenceType, recurrenceValue) {
  if (recurrenceType === 'once') return 'なし';
  if (recurrenceType === 'daily') return '毎日';
  if (recurrenceType === 'weekly') {
    return `毎週${weekdayLabel(Number(recurrenceValue))}`;
  }
  return recurrenceType;
}

// 初回登録時: 指定日時(またはtime_of_day)から見て直近の未来の発火時刻をunix秒で返す
export function computeInitialNextTriggerAt({
  recurrenceType,
  date,
  timeOfDay,
  weekday,
  now = new Date(),
}) {
  if (recurrenceType === 'once') {
    return Math.floor(date.getTime() / 1000);
  }

  const [hh, mm] = timeOfDay.split(':').map(Number);

  if (recurrenceType === 'daily') {
    const next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= now.getTime()) {
      next.setTime(next.getTime() + DAY_MS);
    }
    return Math.floor(next.getTime() / 1000);
  }

  if (recurrenceType === 'weekly') {
    const next = new Date(now);
    next.setHours(hh, mm, 0, 0);
    let diffDays = (weekday - next.getDay() + 7) % 7;
    if (diffDays === 0 && next.getTime() <= now.getTime()) {
      diffDays = 7;
    }
    next.setTime(next.getTime() + diffDays * DAY_MS);
    return Math.floor(next.getTime() / 1000);
  }

  throw new Error(`unknown recurrenceType: ${recurrenceType}`);
}

export const DATETIME_PRESETS = [
  { value: 'in_30_min', label: '30分後' },
  { value: 'in_1_hour', label: '1時間後' },
  { value: 'in_3_hours', label: '3時間後' },
  { value: 'today_20', label: '今日20時' },
  { value: 'tomorrow_9', label: '明日9時' },
  { value: 'tomorrow_20', label: '明日20時' },
  { value: 'next_monday_9', label: '来週月曜9時' },
];

// プリセット選択時の日時計算(サーバー時刻=Asia/Tokyoのウォールクロック基準)
export function computePresetDateTime(presetValue, now = new Date()) {
  const date = new Date(now);
  switch (presetValue) {
    case 'in_30_min':
      date.setMinutes(date.getMinutes() + 30);
      return date;
    case 'in_1_hour':
      date.setHours(date.getHours() + 1);
      return date;
    case 'in_3_hours':
      date.setHours(date.getHours() + 3);
      return date;
    case 'today_20':
      date.setHours(20, 0, 0, 0);
      return date;
    case 'tomorrow_9':
      date.setDate(date.getDate() + 1);
      date.setHours(9, 0, 0, 0);
      return date;
    case 'tomorrow_20':
      date.setDate(date.getDate() + 1);
      date.setHours(20, 0, 0, 0);
      return date;
    case 'next_monday_9': {
      let diffDays = (1 - date.getDay() + 7) % 7;
      if (diffDays === 0) diffDays = 7;
      date.setDate(date.getDate() + diffDays);
      date.setHours(9, 0, 0, 0);
      return date;
    }
    default:
      return null;
  }
}

// 発火後の再計算: ドリフトを防ぐため直前のnext_trigger_atを基準に加算する
export function computeFollowingTriggerAt(recurrenceType, prevTriggerAtUnix) {
  if (recurrenceType === 'daily') {
    return prevTriggerAtUnix + 24 * 60 * 60;
  }
  if (recurrenceType === 'weekly') {
    return prevTriggerAtUnix + 7 * 24 * 60 * 60;
  }
  throw new Error(`recurrenceType ${recurrenceType} has no following trigger`);
}
