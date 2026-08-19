import {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import {
  insertReminder,
  listRemindersByUser,
  deleteReminderByOwner,
} from '../db.js';
import {
  parseReminderDateTime,
  formatDateTimeJa,
  recurrenceLabel,
  computeInitialNextTriggerAt,
} from '../datetime.js';
import { config } from '../config.js';

// modal送信〜セレクトメニュー確定までの一時的な下書きを保持する
// (draftId -> { content, date, timeOfDay, weekday, guildId, channelId, userId })
const pendingDrafts = new Map();
const DRAFT_TTL_MS = 10 * 60 * 1000;

export const data = new SlashCommandBuilder()
  .setName('remind')
  .setDescription('リマインドを管理します')
  .addSubcommand((sub) =>
    sub.setName('add').setDescription('新しいリマインドを追加します')
  )
  .addSubcommand((sub) =>
    sub.setName('list').setDescription('自分が登録したリマインド一覧を表示します')
  )
  .addSubcommand((sub) =>
    sub
      .setName('delete')
      .setDescription('リマインドを削除します')
      .addIntegerOption((opt) =>
        opt
          .setName('id')
          .setDescription('削除するリマインドのID (/remind list で確認できます)')
          .setRequired(true)
      )
  );

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') return showAddModal(interaction);
  if (sub === 'list') return handleList(interaction);
  if (sub === 'delete') return handleDelete(interaction);
}

async function showAddModal(interaction) {
  const modal = new ModalBuilder()
    .setCustomId('remind_add_modal')
    .setTitle('リマインドを追加');

  const contentInput = new TextInputBuilder()
    .setCustomId('remind_content')
    .setLabel('リマインド内容')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(500);

  const datetimeInput = new TextInputBuilder()
    .setCustomId('remind_datetime')
    .setLabel('日時 (例: 明日20時 / 毎週月曜21:00)')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(100);

  modal.addComponents(
    new ActionRowBuilder().addComponents(contentInput),
    new ActionRowBuilder().addComponents(datetimeInput)
  );

  await interaction.showModal(modal);
}

export async function handleModalSubmit(interaction) {
  if (interaction.customId !== 'remind_add_modal') return;

  const content = interaction.fields.getTextInputValue('remind_content');
  const datetimeText = interaction.fields.getTextInputValue('remind_datetime');

  const parsed = parseReminderDateTime(datetimeText, new Date());
  if (!parsed) {
    await interaction.reply({
      content: `日時を解析できませんでした:「${datetimeText}」\n別の書き方でもう一度 /remind add を実行してください。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const draftId = randomUUID();
  pendingDrafts.set(draftId, {
    content,
    date: parsed.date,
    timeOfDay: parsed.timeOfDay,
    weekday: parsed.weekday,
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
  });
  setTimeout(() => pendingDrafts.delete(draftId), DRAFT_TTL_MS).unref();

  const embed = new EmbedBuilder()
    .setTitle('リマインド内容の確認')
    .addFields(
      { name: '内容', value: content },
      { name: '日時', value: formatDateTimeJa(parsed.date) }
    )
    .setFooter({ text: '繰り返しを選択して登録を確定してください' })
    .setColor(0x8bc9ff);

  const select = new StringSelectMenuBuilder()
    .setCustomId(`remind_recurrence_select:${draftId}`)
    .setPlaceholder('繰り返しを選択')
    .addOptions(
      { label: 'なし', description: '一度だけ通知します', value: 'once' },
      { label: '毎日', description: '毎日同じ時刻に通知します', value: 'daily' },
      { label: '毎週', description: '毎週同じ曜日・時刻に通知します', value: 'weekly' }
    );

  await interaction.reply({
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(select)],
    flags: MessageFlags.Ephemeral,
  });
}

export async function handleRecurrenceSelect(interaction) {
  const [, draftId] = interaction.customId.split(':');
  const draft = pendingDrafts.get(draftId);

  if (!draft) {
    await interaction.update({
      content: 'この確認は期限切れです。もう一度 /remind add からやり直してください。',
      embeds: [],
      components: [],
    });
    return;
  }

  const recurrenceType = interaction.values[0]; // 'once' | 'daily' | 'weekly'
  const recurrenceValue =
    recurrenceType === 'weekly' ? String(draft.weekday) : null;

  const nextTriggerAt = computeInitialNextTriggerAt({
    recurrenceType,
    date: draft.date,
    timeOfDay: draft.timeOfDay,
    weekday: draft.weekday,
    now: new Date(),
  });

  const id = insertReminder({
    guildId: draft.guildId,
    channelId: draft.channelId,
    userId: draft.userId,
    content: draft.content,
    recurrenceType,
    recurrenceValue,
    timeOfDay: draft.timeOfDay,
    timezone: config.timezone,
    nextTriggerAt,
  });

  pendingDrafts.delete(draftId);

  const embed = new EmbedBuilder()
    .setTitle('リマインドを登録しました 🐾')
    .addFields(
      { name: 'ID', value: String(id), inline: true },
      {
        name: '繰り返し',
        value: recurrenceLabel(recurrenceType, recurrenceValue),
        inline: true,
      },
      {
        name: '次回発火',
        value: formatDateTimeJa(new Date(nextTriggerAt * 1000)),
      },
      { name: '内容', value: draft.content }
    )
    .setColor(0x8bc9ff);

  await interaction.update({ embeds: [embed], components: [] });
}

async function handleList(interaction) {
  const reminders = listRemindersByUser(interaction.guildId, interaction.user.id);

  if (reminders.length === 0) {
    await interaction.reply({
      content: '登録されているリマインドはありません。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const lines = reminders.map((r) => {
    const next = formatDateTimeJa(new Date(r.next_trigger_at * 1000));
    const recurrence = recurrenceLabel(r.recurrence_type, r.recurrence_value);
    return `**#${r.id}** ${r.content}\n　次回: ${next} / 繰り返し: ${recurrence}`;
  });

  const embed = new EmbedBuilder()
    .setTitle('あなたのリマインド一覧')
    .setDescription(lines.join('\n\n'))
    .setColor(0x8bc9ff);

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

async function handleDelete(interaction) {
  const id = interaction.options.getInteger('id', true);
  const deleted = deleteReminderByOwner(id, interaction.user.id);

  if (!deleted) {
    await interaction.reply({
      content: `ID ${id} のリマインドが見つからないか、削除権限がありません。`,
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.reply({
    content: `ID ${id} のリマインドを削除しました。`,
    flags: MessageFlags.Ephemeral,
  });
}
