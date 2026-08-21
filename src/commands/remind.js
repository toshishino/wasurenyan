import {
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
  ModalBuilder,
  LabelBuilder,
  TextInputStyle,
  SelectMenuDefaultValueType,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
} from 'discord.js';
import {
  insertReminder,
  listRemindersByUser,
  deleteReminderByOwner,
} from '../db.js';
import {
  formatDateTimeJa,
  formatDateTimeShortJa,
  formatTimeOfDay,
  recurrenceLabel,
  computeInitialNextTriggerAt,
  DATETIME_PRESETS,
  computePresetDateTime,
} from '../datetime.js';
import { formatMentionTarget } from '../mentions.js';
import { config } from '../config.js';

// リマインド内容欄(remind_content)のsetMaxLengthと必ず一致させる
const CONTENT_MAX_LENGTH = 500;
const CONTENT_TRUNCATION_SUFFIX = '...(省略)';

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

export const contextMenuData = new ContextMenuCommandBuilder()
  .setName('このメッセージをリマインド')
  .setType(ApplicationCommandType.Message);

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') {
    return showAddModal(interaction, { defaultChannelId: interaction.channelId });
  }
  if (sub === 'list') return handleList(interaction);
  if (sub === 'delete') return handleDelete(interaction);
}

export async function executeMessageContextMenu(interaction) {
  const message = interaction.targetMessage;
  const initialContent = buildContentFromMessage(message);
  await showAddModal(interaction, {
    initialContent,
    defaultChannelId: message.channelId,
  });
}

// 対象メッセージの本文+元メッセージへのリンクを「内容」欄の初期値として組み立てる
// (本文が空=embedのみの場合はリンクだけになる)
function buildContentFromMessage(message) {
  const link = `https://discord.com/channels/${message.guildId}/${message.channelId}/${message.id}`;
  const linkBlock = `\n\n元メッセージ: ${link}`;
  const originalText = message.content ?? '';

  const availableForBody = CONTENT_MAX_LENGTH - linkBlock.length;
  let body = originalText;
  if (body.length > availableForBody) {
    const truncateAt = Math.max(0, availableForBody - CONTENT_TRUNCATION_SUFFIX.length);
    body = body.slice(0, truncateAt) + CONTENT_TRUNCATION_SUFFIX;
  }

  return `${body}${linkBlock}`.trim();
}

// 内容・日時プリセット・投稿先チャンネル・メンション対象・繰り返しの5項目を
// 1つのモーダルで完結させる(/remind add とメッセージコンテキストメニューの共通処理)
async function showAddModal(interaction, { initialContent = '', defaultChannelId } = {}) {
  const now = new Date();

  const contentLabel = new LabelBuilder()
    .setLabel('内容')
    .setTextInputComponent((input) => {
      input
        .setCustomId('remind_content')
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(CONTENT_MAX_LENGTH);
      if (initialContent) input.setValue(initialContent);
      return input;
    });

  const datetimeLabel = new LabelBuilder()
    .setLabel('日時')
    .setStringSelectMenuComponent((select) =>
      select
        .setCustomId('remind_datetime_preset')
        .setRequired(true)
        .addOptions(
          DATETIME_PRESETS.map((preset) => ({
            label: `${preset.label} (${formatDateTimeShortJa(computePresetDateTime(preset.value, now))})`,
            value: preset.value,
          }))
        )
    );

  const channelLabel = new LabelBuilder()
    .setLabel('投稿先チャンネル')
    .setChannelSelectMenuComponent((select) =>
      select
        .setCustomId('remind_channel_select')
        .setRequired(true)
        .setChannelTypes(ChannelType.GuildText)
        .setDefaultChannels(defaultChannelId)
    );

  const mentionLabel = new LabelBuilder()
    .setLabel('メンション対象')
    .setMentionableSelectMenuComponent((select) =>
      select
        .setCustomId('remind_mention_select')
        .setRequired(false)
        .setMinValues(0)
        .setMaxValues(10)
        .setDefaultValues({ id: interaction.user.id, type: SelectMenuDefaultValueType.User })
    );

  const recurrenceSelectLabel = new LabelBuilder()
    .setLabel('繰り返し設定')
    .setStringSelectMenuComponent((select) =>
      select
        .setCustomId('remind_recurrence_select')
        .setRequired(true)
        .addOptions(
          {
            label: 'なし',
            description: '一度だけ通知します',
            value: 'once',
            default: true,
          },
          {
            label: '毎日',
            description: '毎日同じ時刻に通知します',
            value: 'daily',
          },
          {
            label: '毎週',
            description: '毎週同じ曜日・時刻に通知します',
            value: 'weekly',
          }
        )
    );

  const modal = new ModalBuilder()
    .setCustomId('remind_add_modal')
    .setTitle('リマインドを追加')
    .addLabelComponents(
      contentLabel,
      datetimeLabel,
      channelLabel,
      mentionLabel,
      recurrenceSelectLabel
    );

  await interaction.showModal(modal);
}

// 登録までの残り時間を「あと2時間30分」のような表現にする
function formatRelativeDuration(ms) {
  if (ms <= 0) return 'まもなく';

  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;

  const parts = [];
  if (days > 0) parts.push(`${days}日`);
  if (hours > 0) parts.push(`${hours}時間`);
  if (minutes > 0 || parts.length === 0) parts.push(`${minutes}分`);
  return parts.join('');
}

export async function handleModalSubmit(interaction) {
  if (interaction.customId !== 'remind_add_modal') return;

  const content = interaction.fields.getTextInputValue('remind_content');
  const presetValue = interaction.fields.getStringSelectValues('remind_datetime_preset')[0];
  const recurrenceType = interaction.fields.getStringSelectValues('remind_recurrence_select')[0];

  const channels = interaction.fields.getSelectedChannels('remind_channel_select', true);
  const channelId = channels.first().id;

  const mentionables = interaction.fields.getSelectedMentionables('remind_mention_select', false);
  const mentionTargets = mentionables
    ? [
        ...mentionables.users.map((user) => ({ id: user.id, type: 'user' })),
        ...mentionables.roles.map((role) => ({ id: role.id, type: 'role' })),
      ]
    : [];

  const now = new Date();
  const date = computePresetDateTime(presetValue, now);
  const timeOfDay = formatTimeOfDay(date);
  const weekday = date.getDay();
  const recurrenceValue = recurrenceType === 'weekly' ? String(weekday) : null;

  const nextTriggerAt = computeInitialNextTriggerAt({
    recurrenceType,
    date,
    timeOfDay,
    weekday,
    now,
  });

  const id = insertReminder({
    guildId: interaction.guildId,
    channelId,
    userId: interaction.user.id,
    content,
    recurrenceType,
    recurrenceValue,
    timeOfDay,
    timezone: config.timezone,
    nextTriggerAt,
    mentionTargets,
  });

  const preset = DATETIME_PRESETS.find((p) => p.value === presetValue);
  const mentionText =
    mentionTargets.length > 0 ? mentionTargets.map(formatMentionTarget).join(' ') : 'なし';
  const remainingMs = nextTriggerAt * 1000 - now.getTime();

  const embed = new EmbedBuilder()
    .setTitle('リマインドを登録しました 🐾')
    .setDescription(
      `**内容**\n${content}\n\n` +
        `📅 日時: ${preset?.label ?? presetValue}（あと${formatRelativeDuration(remainingMs)}）\n` +
        `📢 投稿先: <#${channelId}>\n` +
        `🔔 メンション: ${mentionText}\n` +
        `🔁 繰り返し: ${recurrenceLabel(recurrenceType, recurrenceValue)}`
    )
    .addFields({ name: 'ID', value: String(id), inline: true })
    .setColor(0x8bc9ff);

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
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
