import { Client, GatewayIntentBits, Events } from 'discord.js';
import { config } from './src/config.js';
import * as remind from './src/commands/remind.js';
import { startScheduler } from './src/scheduler.js';

const commands = new Map([[remind.data.name, remind]]);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (readyClient) => {
  console.log(`ログインしました: ${readyClient.user.tag}`);
  startScheduler(client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      const command = commands.get(interaction.commandName);
      if (!command) return;
      await command.execute(interaction);
      return;
    }

    if (interaction.isMessageContextMenuCommand()) {
      if (interaction.commandName === remind.contextMenuData.name) {
        await remind.executeMessageContextMenu(interaction);
      }
      return;
    }

    if (interaction.isModalSubmit()) {
      await remind.handleModalSubmit(interaction);
      return;
    }

    if (interaction.isChannelSelectMenu()) {
      if (interaction.customId === 'remind_channel_select') {
        await remind.handleChannelSelect(interaction);
      }
      return;
    }

    if (interaction.isMentionableSelectMenu()) {
      if (interaction.customId === 'remind_mentionable_select') {
        await remind.handleMentionableSelect(interaction);
      }
      return;
    }

    if (interaction.isStringSelectMenu()) {
      if (interaction.customId === 'remind_recurrence_select') {
        await remind.handleRecurrenceSelect(interaction);
      } else if (interaction.customId === 'datetime_preset') {
        await remind.handleDateTimePresetSelect(interaction);
      }
      return;
    }

    if (interaction.isButton()) {
      if (interaction.customId === 'remind_register_button') {
        await remind.handleRegisterButton(interaction);
      }
      return;
    }
  } catch (err) {
    console.error('インタラクション処理中にエラーが発生しました:', err);
    const errorMessage = { content: 'エラーが発生しました。', ephemeral: true };
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errorMessage).catch(() => {});
    } else {
      await interaction.reply(errorMessage).catch(() => {});
    }
  }
});

client.login(config.discordToken);
