import {
  SlashCommandBuilder,
  ContextMenuCommandBuilder,
  ApplicationCommandType,
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
  formatDateTimeShortJa,
  formatTimeOfDay,
  recurrenceLabel,
  computeInitialNextTriggerAt,
  DATETIME_PRESETS,
  computePresetDateTime,
} from '../datetime.js';
import { formatMentionTarget } from '../mentions.js';
import { config } from '../config.js';

// modal送信〜登録ボタン押下までの一時的な下書きを保持する
// (メッセージid -> { content, customDateTimeText, parsedDateTime, selectedPreset, dateTimeSource,
//                    customDateTimeInvalid, guildId, userId, defaultChannelId, channelId,
//                    mentionTargets, recurrenceType, updatedAt })
const draftReminders = new Map();
const DRAFT_TTL_MS = 10 * 60 * 1000;

// 何も選ばず登録しても妥当な内容になるよう、日時プリセットのデフォルトは「1時間後」
const DEFAULT_PRESET_VALUE = 'in_1_hour';

// リマインド内容欄(remind_content)のsetMaxLengthと必ず一致させる
const CONTENT_MAX_LENGTH = 500;
const CONTENT_TRUNCATION_SUFFIX = '...(省略)';

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

export const contextMenuData = new ContextMenuCommandBuilder()
  .setName('このメッセージをリマインド')
  .setType(ApplicationCommandType.Message);

export async function execute(interaction) {
  const sub = interaction.options.getSubcommand();
  if (sub === 'add') return showAddModal(interaction);
  if (sub === 'list') return handleList(interaction);
  if (sub === 'delete') return handleDelete(interaction);
}

export async function executeMessageContextMenu(interaction) {
  const initialContent = buildContentFromMessage(interaction.targetMessage);
  await showAddModal(interaction, { initialContent });
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

async function showAddModal(interaction, { initialContent = '' } = {}) {
  const modal = new ModalBuilder()
    .setCustomId('remind_add_modal')
    .setTitle('リマインドを追加');

  const contentInput = new TextInputBuilder()
    .setCustomId('remind_content')
    .setLabel('リマインド内容')
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMaxLength(CONTENT_MAX_LENGTH);
  if (initialContent) {
    contentInput.setValue(initialContent);
  }

  const datetimeInput = new TextInputBuilder()
    .setCustomId('remind_datetime')
    .setLabel('日時（カスタム指定、任意）')
    .setPlaceholder('プリセットで足りない場合のみ入力（例: 来月第3土曜 15時）')
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(100);

  modal.addComponents(
    new ActionRowBuilder().addComponents(contentInput),
    new ActionRowBuilder().addComponents(datetimeInput)
  );

  await interaction.showModal(modal);
}

// モーダル送信直後の日時デフォルトを決定する:
// カスタム入力があればそれを優先してパースし、無い/パース不可ならプリセット「1時間後」を採用する
function resolveInitialDateTime(customDateTimeText, now = new Date()) {
  const defaultPreset = DATETIME_PRESETS.find((p) => p.value === DEFAULT_PRESET_VALUE);
  const fallback = {
    parsedDateTime: computePresetDateTime(defaultPreset.value, now),
    selectedPreset: defaultPreset.label,
    dateTimeSource: 'preset',
  };

  if (!customDateTimeText) {
    return { ...fallback, customDateTimeInvalid: false };
  }

  const parsed = parseReminderDateTime(customDateTimeText, now);
  if (parsed) {
    return {
      parsedDateTime: parsed.date,
      selectedPreset: null,
      dateTimeSource: 'custom',
      customDateTimeInvalid: false,
    };
  }

  return { ...fallback, customDateTimeInvalid: true };
}

export async function handleModalSubmit(interaction) {
  if (interaction.customId !== 'remind_add_modal') return;

  const content = interaction.fields.getTextInputValue('remind_content');
  const customDateTimeText =
    interaction.fields.getTextInputValue('remind_datetime').trim() || null;

  const initial = resolveInitialDateTime(customDateTimeText);

  const draft = {
    content,
    customDateTimeText,
    parsedDateTime: initial.parsedDateTime,
    selectedPreset: initial.selectedPreset,
    dateTimeSource: initial.dateTimeSource,
    customDateTimeInvalid: initial.customDateTimeInvalid,
    guildId: interaction.guildId,
    userId: interaction.user.id,
    defaultChannelId: interaction.channelId,
    channelId: interaction.channelId,
    mentionTargets: [{ id: interaction.user.id, type: 'user' }],
    recurrenceType: 'once',
    updatedAt: Date.now(),
  };

  const response = await interaction.reply({
    ...buildDraftMessage(draft),
    flags: MessageFlags.Ephemeral,
    withResponse: true,
  });

  draftReminders.set(response.resource.message.id, draft);
}

// 繰り返し(weekly)の曜日はdraft.parsedDateTimeから都度算出する(常に確定済み)
function currentRecurrenceValue(draft) {
  if (draft.recurrenceType !== 'weekly') return null;
  return String(draft.parsedDateTime.getDay());
}

// フォローアップメッセージ本文に表示する「現在の設定」の要約テキスト
function buildDraftSummaryText(draft) {
  const relativeLabel =
    draft.dateTimeSource === 'custom'
      ? `カスタム「${draft.customDateTimeText}」`
      : draft.selectedPreset;
  const mentionText =
    draft.mentionTargets.length > 0
      ? draft.mentionTargets.map(formatMentionTarget).join(' ')
      : 'なし';
  const recurrenceText = recurrenceLabel(draft.recurrenceType, currentRecurrenceValue(draft));

  const lines = [
    `📅 日時: ${relativeLabel}（${formatDateTimeShortJa(draft.parsedDateTime)}）`,
    `📢 投稿先: <#${draft.channelId}>`,
    `🔔 メンション: ${mentionText}`,
    `🔁 繰り返し: ${recurrenceText}`,
  ];

  if (draft.customDateTimeInvalid) {
    lines.push(
      `⚠️ カスタム日時「${draft.customDateTimeText}」を解釈できなかったため、デフォルト値を使用しています`
    );
  }

  return lines.join('\n');
}

function buildDraftMessage(draft) {
  const embed = new EmbedBuilder()
    .setTitle('リマインド内容の確認')
    .setDescription(`**内容**\n${draft.content}\n\n${buildDraftSummaryText(draft)}`)
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

  const presetNow = new Date();
  const presetSelect = new StringSelectMenuBuilder()
    .setCustomId('datetime_preset')
    .setPlaceholder('日時プリセットを選択')
    .addOptions(
      DATETIME_PRESETS.map((preset) => ({
        label: `${preset.label} (${formatDateTimeShortJa(computePresetDateTime(preset.value, presetNow))})`,
        value: preset.value,
        default: draft.selectedPreset === preset.label,
      }))
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
      new ActionRowBuilder().addComponents(presetSelect),
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

  draft.recurrenceType = interaction.values[0]; // 'once' | 'daily' | 'weekly'
  draft.updatedAt = Date.now();

  await interaction.update(buildDraftMessage(draft));
}

export async function handleDateTimePresetSelect(interaction) {
  const draft = getActiveDraft(interaction);
  if (!draft) return replyDraftExpired(interaction);

  const presetValue = interaction.values[0];
  const preset = DATETIME_PRESETS.find((p) => p.value === presetValue);
  draft.parsedDateTime = computePresetDateTime(presetValue, new Date());
  draft.selectedPreset = preset?.label ?? presetValue;
  draft.dateTimeSource = 'preset';
  draft.customDateTimeInvalid = false;
  draft.updatedAt = Date.now();

  await interaction.update(buildDraftMessage(draft));
}

export async function handleRegisterButton(interaction) {
  const draft = getActiveDraft(interaction);
  if (!draft) return replyDraftExpired(interaction);

  const date = draft.parsedDateTime;
  const timeOfDay = formatTimeOfDay(date);
  const weekday = date.getDay();
  const recurrenceValue = draft.recurrenceType === 'weekly' ? String(weekday) : null;

  const nextTriggerAt = computeInitialNextTriggerAt({
    recurrenceType: draft.recurrenceType,
    date,
    timeOfDay,
    weekday,
    now: new Date(),
  });

  const id = insertReminder({
    guildId: draft.guildId,
    channelId: draft.channelId,
    userId: draft.userId,
    content: draft.content,
    recurrenceType: draft.recurrenceType,
    recurrenceValue,
    timeOfDay,
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
        value: recurrenceLabel(draft.recurrenceType, recurrenceValue),
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
