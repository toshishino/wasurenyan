import { config as loadEnv } from 'dotenv';

loadEnv({ path: process.env.NODE_ENV === 'production' ? '.env.production' : '.env' });

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(
      `[起動エラー] 環境変数 ${name} が設定されていません。.env.example を参考に .env を作成してください。`
    );
    process.exit(1);
  }
  return value;
}

// Date計算をAsia/Tokyoのウォールクロックに揃えるため、他の処理より先にTZを確定させる
process.env.TZ = process.env.TZ || 'Asia/Tokyo';

export const config = {
  discordToken: requireEnv('DISCORD_TOKEN'),
  clientId: requireEnv('CLIENT_ID'),
  guildId: process.env.GUILD_ID || null,
  timezone: process.env.TZ,
};
