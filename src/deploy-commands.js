import { REST, Routes } from 'discord.js';
import { config } from './config.js';
import { data as remindCommand } from './commands/remind.js';

const commands = [remindCommand.toJSON()];
const rest = new REST().setToken(config.discordToken);

async function main() {
  const route = config.guildId
    ? Routes.applicationGuildCommands(config.clientId, config.guildId)
    : Routes.applicationCommands(config.clientId);

  console.log(
    config.guildId
      ? `ギルド(${config.guildId})限定でスラッシュコマンドを登録します...`
      : 'グローバルスラッシュコマンドを登録します (反映まで最大1時間程度)...'
  );

  await rest.put(route, { body: commands });
  console.log('スラッシュコマンドの登録が完了しました。');
}

main().catch((err) => {
  console.error('スラッシュコマンドの登録に失敗しました:', err);
  process.exit(1);
});
