# わすれニャン (wasurenyan)

Discord上でスラッシュコマンドから自然言語でリマインドを登録できるBotです。

## 機能

- `/remind add` — モーダルで「内容」「日時（自然言語）」を入力し、確認メッセージとセレクトメニュー（繰り返し: なし/毎日/毎週）で登録を確定します。
- `/remind list` — 自分が登録したリマインド一覧（ID・内容・次回発火日時・繰り返し種別）を表示します。
- `/remind delete id:<id>` — 指定IDのリマインドを削除します（登録した本人のみ）。
- 毎分動くスケジューラが `next_trigger_at` を過ぎた有効なリマインドをチャンネルに投稿し、`once` は無効化、`daily`/`weekly` は次回発火日時を再計算します。

## 技術スタック

- Node.js (v22.5以降 / `node:sqlite` を使用)
- [discord.js](https://discord.js.org/) v14
- `node:sqlite`（追加の依存なしでSQLiteを使用）
- [node-cron](https://www.npmjs.com/package/node-cron)（毎分実行のスケジューラ）
- [chrono-node](https://github.com/wanasit/chrono)（日本語自然言語の日時パース）

## セットアップ

### 1. Discord Developer Portalでのアプリ作成手順

1. [Discord Developer Portal](https://discord.com/developers/applications) にアクセスし、「New Application」からアプリを作成します。
2. 左メニュー「Bot」を開き、「Add Bot」→「Reset Token」でBotトークンを取得します（`.env` の `DISCORD_TOKEN` に設定）。
3. 「General Information」に表示される「Application ID」を `.env` の `CLIENT_ID` に設定します。
4. 「Bot」ページの「Privileged Gateway Intents」は本Botでは不要です（デフォルトのまま）。
5. テスト用Botと本番用Botは、Discord Developer Portal上で**別々のApplicationとして作成**してください（例: 「わすれニャン (dev)」「わすれニャン」）。それぞれ個別のトークン・Client IDが発行されるため、`.env`（テスト用）と `.env.production`（本番用）にそれぞれ設定します。本番用Applicationの作成自体はとしあき本人がDeveloper Portalで手動実施してください。

### 2. Botの権限設定（招待URLの発行）

「OAuth2」→「URL Generator」で以下を選択して招待URLを発行し、Botを導入したいサーバーに招待します。

- **Scopes**: `bot`, `applications.commands`
- **Bot Permissions**:
  - `View Channels`
  - `Send Messages`
  - `Embed Links`

上記スコープ・権限で生成されたURLをブラウザで開き、対象サーバーを選択して認証してください。

### 3. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を編集し、`DISCORD_TOKEN` と `CLIENT_ID` を設定します。未設定のまま起動した場合、Botはフォールバックせず起動時エラーで即終了します（ふえニャンと同様の方針）。`GUILD_ID` を設定すると開発中はそのギルドにのみ即時反映されるコマンド登録になります（未設定時はグローバル登録、反映まで最大1時間程度）。

### 4. インストールとコマンド登録・起動

```bash
npm install
npm run deploy-commands   # スラッシュコマンドをDiscordに登録
npm start                 # Bot起動
```

初回起動時に `reminders.db`（SQLiteファイル）がカレントディレクトリに自動作成されます。

## 環境構築（テスト用/本番用）

わすれニャンは `NODE_ENV` の値によって、読み込む環境変数ファイルとSQLiteのDBファイルを自動的に切り替えます。テスト用Botと本番用Botのトークン・データを完全に分離できるため、本番運用中でも安全にテスト用Botで動作確認ができます。

| | テスト用 | 本番用 |
| --- | --- | --- |
| `NODE_ENV` | 未設定（またはproduction以外） | `production` |
| 読み込む環境変数ファイル | `.env` | `.env.production` |
| DBファイル | `reminders.db` | `reminders.production.db` |
| コマンド登録スコープ | `.env`/`.env.production`の`GUILD_ID`の有無で決まる（下記参照） | 同左 |

使い分け方:

1. `.env.example` を `.env` としてコピーし、テスト用BotのトークンやClient IDを設定します（`NODE_ENV` は空のままでOKです）。
2. 本番用には `.env.example` を `.env.production` としてコピーし、本番用BotのトークンやClient IDを設定した上で `NODE_ENV=production` を追記します。
3. どちらのファイルも `.env`・`.env.production` ともにGit管理対象外です（`.env.example` のみコミットされます）。
4. 起動・コマンド登録時に `NODE_ENV=production` を指定すると本番用の設定が使われます。

```bash
# テスト用Botとして起動（.env を読み込む）
npm start

# 本番用Botとして起動（.env.production を読み込む）
NODE_ENV=production npm start

# コマンド登録も同様にNODE_ENVで切り替え可能
NODE_ENV=production npm run deploy-commands
```

コマンド登録スコープは、読み込まれた環境変数ファイル内の `GUILD_ID` の有無で自動的に決まります。`GUILD_ID` を設定していればそのギルドに限定登録（即時反映、テスト用向け）、未設定であればグローバル登録（本番用向け、反映まで最大1時間程度かかります）になります。

## DBスキーマ (`reminders` テーブル)

| カラム | 型 | 説明 |
| --- | --- | --- |
| id | INTEGER PK AUTOINCREMENT | リマインドID |
| guild_id | TEXT | サーバーID |
| channel_id | TEXT | 投稿先チャンネルID |
| user_id | TEXT | 登録者のユーザーID |
| content | TEXT | リマインド内容 |
| recurrence_type | TEXT | `once` / `daily` / `weekly` |
| recurrence_value | TEXT | `weekly` の場合の曜日（0=日〜6=土）、それ以外はNULL |
| time_of_day | TEXT | `HH:mm` |
| timezone | TEXT | デフォルト `Asia/Tokyo` |
| next_trigger_at | INTEGER | 次回発火日時（unixタイムスタンプ秒） |
| active | INTEGER | 有効フラグ（0/1） |
| created_at | INTEGER | 作成日時（unixタイムスタンプ秒） |

## systemdでの常駐運用（OCI VM想定）

`systemd/wasurenyan.service` をサンプルとして同梱しています。本番用Botとして常駐させるため、`Environment=NODE_ENV=production` を指定しています（`.env.production` を読み込み、DBも `reminders.production.db` に分離されます）。

```bash
sudo useradd -r -s /usr/sbin/nologin wasurenyan   # 必要に応じて
sudo mkdir -p /opt/wasurenyan
sudo cp -r . /opt/wasurenyan
sudo chown -R wasurenyan:wasurenyan /opt/wasurenyan
sudo cp systemd/wasurenyan.service /etc/systemd/system/wasurenyan.service
sudo systemctl daemon-reload
sudo systemctl enable --now wasurenyan
sudo journalctl -u wasurenyan -f   # ログ確認
```

`WorkingDirectory`・`User`・Node.jsのパス（`ExecStart`）は実際のデプロイ環境に合わせて調整してください。

## ブランチ運用

- `main`: 本番専用。直接コミット禁止（`dev` からのマージのみ）。
- `dev`: 開発用ブランチ。通常の作業はここで行います。

## スコープ外（今回は未対応）

- Web管理画面
- YouTube/Twitchなど他プラットフォーム連携
- リマインドの編集機能（削除して再登録することで代替してください）
