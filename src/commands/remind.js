import {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  MentionableSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  SelectMenuDefaultValueType,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
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
import { formatMentionTarget } from '../mentions.js';
import { config } from '../config.js';

// modal送信〜登録ボタン押下までの一時的な下書きを保持する
// (メッセージid -> { content, date, timeOfDay, weekday, guildId, userId,
//                    defaultChannelId, channelId, mentionTargets, recurrenceType, recurrenceValue, updatedAt })
const draftReminders = new Map();
const DRAFT_TTL_MS = 10 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [messageId, draft] of draftReminders) {
    if (now - draft.updatedAt > DRAFT_TTL_MS) {
      draftReminders.delete(messageId);
    }
  }
}, 60 * 1000).unref();

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

  const draft = {
    content,
    date: parsed.date,
    timeOfDay: parsed.timeOfDay,
    weekday: parsed.weekday,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    defaultChannelId: interaction.channelId,
    channelId: interaction.channelId,
    mentionTargets: [],
    recurrenceType: null,
    recurrenceValue: null,
    updatedAt: Date.now(),
  };

  const response = await interaction.reply({
    ...buildDraftMessage(draft),
    flags: MessageFlags.Ephemeral,
    withResponse: true,
  });

  draftReminders.set(response.resource.message.id, draft);
}

function buildDraftMessage(draft) {
  const mentionText =
    draft.mentionTargets.length > 0
      ? draft.mentionTargets.map(formatMentionTarget).join(' ')
      : 'なし';

  const embed = new EmbedBuilder()
    .setTitle('リマインド内容の確認')
    .addFields(
      { name: '内容', value: draft.content },
      { name: '日時', value: formatDateTimeJa(draft.date) },
      { name: '投稿先チャンネル', value: `<#${draft.channelId}>` },
      { name: 'メンション対象', value: mentionText },
      {
        name: '繰り返し',
        value: draft.recurrenceType
          ? recurrenceLabel(draft.recurrenceType, draft.recurrenceValue)
          : '未選択（登録に必須です）',
      }
    )
    .setFooter({ text: '各項目を選択し、「登録」ボタンで確定してください' })
    .setColor(0x8bc9ff);

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('remind_channel_select')
    .setPlaceholder('投稿先チャンネル（未選択: 実行チャンネル）')
    .setMinValues(0)
    .setMaxValues(1)
    .setDefaultChannels(draft.channelId);

  const mentionableSelect = new MentionableSelectMenuBuilder()
    .setCustomId('remind_mentionable_select')
    .setPlaceholder('メンション対象（複数選択可、任意）')
    .setMinValues(0)
    .setMaxValues(10);
  if (draft.mentionTargets.length > 0) {
    mentionableSelect.setDefaultValues(
      draft.mentionTargets.map((target) => ({
        id: target.id,
        type:
          target.type === 'role'
            ? SelectMenuDefaultValueType.Role
            : SelectMenuDefaultValueType.User,
      }))
    );
  }

  const recurrenceSelect = new StringSelectMenuBuilder()
    .setCustomId('remind_recurrence_select')
    .setPlaceholder('繰り返しを選択（必須）')
    .addOptions(
      {
        label: 'なし',
        description: '一度だけ通知します',
        value: 'once',
        default: draft.recurrenceType === 'once',
      },
      {
        label: '毎日',
        description: '毎日同じ時刻に通知します',
        value: 'daily',
        default: draft.recurrenceType === 'daily',
      },
      {
        label: '毎週',
        description: '毎週同じ曜日・時刻に通知します',
        value: 'weekly',
        default: draft.recurrenceType === 'weekly',
      }
    );

  const registerButton = new ButtonBuilder()
    .setCustomId('remind_register_button')
    .setLabel('登録')
    .setStyle(ButtonStyle.Primary);

  return {
    embeds: [embed],
    components: [
      new ActionRowBuilder().addComponents(channelSelect),
      new ActionRowBuilder().addComponents(mentionableSelect),
      new ActionRowBuilder().addComponents(recurrenceSelect),
      new ActionRowBuilder().addComponents(registerButton),
    ],
  };
}

function getActiveDraft(interaction) {
  return draftReminders.get(interaction.message.id);
}

async function replyDraftExpired(interaction) {
  await interaction.update({
    content: 'この確認は期限切れです。もう一度 /remind add からやり直してください。',
    embeds: [],
    components: [],
  });
}

export async function handleChannelSelect(interaction) {
  const draft = getActiveDraft(interaction);
  if (!draft) return replyDraftExpired(interaction);

  draft.channelId = interaction.values[0] ?? draft.defaultChannelId;
  draft.updatedAt = Date.now();

  await interaction.update(buildDraftMessage(draft));
}

export async function handleMentionableSelect(interaction) {
  const draft = getActiveDraft(interaction);
  if (!draft) return replyDraftExpired(interaction);

  draft.mentionTargets = interaction.values.map((id) => ({
    id,
    type: interaction.users.has(id) ? 'user' : 'role',
  }));
  draft.updatedAt = Date.now();

  await interaction.update(buildDraftMessage(draft));
}

export async function handleRecurrenceSelect(interaction) {
  const draft = getActiveDraft(interaction);
  if (!draft) return replyDraftExpired(interaction);

  const recurrenceType = interaction.values[0]; // 'once' | 'daily' | 'weekly'
  draft.recurrenceType = recurrenceType;
  draft.recurrenceValue = recurrenceType === 'weekly' ? String(draft.weekday) : null;
  draft.updatedAt = Date.now();

  await interaction.update(buildDraftMessage(draft));
}

export async function handleRegisterButton(interaction) {
  const draft = getActiveDraft(interaction);
  if (!draft) return replyDraftExpired(interaction);

  if (!draft.recurrenceType) {
    await interaction.reply({
      content: '繰り返し設定を選んでください。',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const nextTriggerAt = computeInitialNextTriggerAt({
    recurrenceType: draft.recurrenceType,
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
    recurrenceType: draft.recurrenceType,
    recurrenceValue: draft.recurrenceValue,
    timeOfDay: draft.timeOfDay,
    timezone: config.timezone,
    nextTriggerAt,
    mentionTargets: draft.mentionTargets,
  });

  draftReminders.delete(interaction.message.id);

  const mentionText =
    draft.mentionTargets.length > 0
      ? draft.mentionTargets.map(formatMentionTarget).join(' ')
      : 'なし';

  const embed = new EmbedBuilder()
    .setTitle('リマインドを登録しました 🐾')
    .addFields(
      { name: 'ID', value: String(id), inline: true },
      {
        name: '繰り返し',
        value: recurrenceLabel(draft.recurrenceType, draft.recurrenceValue),
        inline: true,
      },
      {
        name: '次回発火',
        value: formatDateTimeJa(new Date(nextTriggerAt * 1000)),
      },
      { name: '投稿先チャンネル', value: `<#${draft.channelId}>` },
      { name: 'メンション対象', value: mentionText },
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
