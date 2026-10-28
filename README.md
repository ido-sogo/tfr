# まちの交通レポート

道路や交通の気づきを地図で共有する、ブラウザー向けのWebアプリです。
`index.html` がホームページ、`map.html` が地図・投稿一覧ページです。

## 使い方

- ホーム画面（`index.html`）の「地図を見る」から、地図と投稿一覧（`map.html`）を開きます。
- 閲覧モードでは投稿を閲覧できます。地図上部の検索欄には場所の検索と投稿一覧の絞り込みを兼ねさせています。マーカーにカーソルを合わせると投稿タイトルが表示されます。
- 「提案する」モードで地図を選ぶと、その地点の投稿を作成できます。
- スマートフォンでは地図を画面いっぱいに表示し、「投稿一覧を見る」から一覧を下部パネルで開けます。
- Supabaseを設定していない場合、投稿は現在のブラウザー内に保存され、その端末から削除できます。このローカル保存には管理者権限の保護はありません。

## Supabaseの設定

1. SupabaseプロジェクトのProject URLと公開用anon keyを `supabase-config.js` に設定します。
2. `supabase-schema.sql` をSupabase SQL Editorで実行します。
3. アプリでアカウント登録すると、投稿にはログインが必要です。ログイン中の利用者は自分の投稿を削除できます。未ログイン投稿は管理者のみ削除できます。
4. SupabaseのAuthentication URL Configurationで、アプリの `map.html` のURLをSite URLまたはRedirect URLsに登録してください。メール確認とパスワード再設定のリンク先に使われます。
5. 管理者パスワード認証へ移行するときは、`supabase-admin-password-migration.sql` を一度だけ実行してください。これは旧方式で付与された管理者権限をすべて取り消します。

現在のSupabase設定では新規登録は有効で、メール確認が必須です。登録後は確認メール内のリンクを開いてください。メール送信に失敗する場合はSupabaseのSMTP設定と送信上限を確認し、公開利用には独自SMTPを設定してください。アプリは登録の失敗理由を画面に表示します。

アカウント画面ではログインと新規登録を切り替えられます。確認メールの再送、パスワードの表示切り替え、パスワード再設定と再設定後の更新にも対応しています。新規登録と再設定のパスワードは8文字以上です。

## 管理者パスワード認証

管理者権限は新規登録だけでは付与されません。ログイン後、アカウント画面の「管理者認証」で管理者パスワードを入力します。パスワード照合と権限付与はEdge Function上で行い、ブラウザーやSQLに管理者パスワードを保存しません。認証試行はアカウントごとに1時間あたり5回までです。

1. SupabaseのEdge Function Secretsに `ADMIN_SETUP_PASSWORD` を設定します。十分に長く推測しにくい専用パスワードを使い、ソースコードやチャットには貼らないでください。
2. `supabase-schema.sql` を適用した後、上記の一回限りの管理者移行SQLを実行します。
3. アプリと同じオリジンを `ALLOWED_ORIGIN` に設定し、`claim-admin` 関数をデプロイします。

```sh
supabase functions deploy claim-admin
```

旧管理者を残す必要がある場合は、移行SQLの実行前に確認してください。移行後は、正しい管理者パスワードで認証したアカウントだけが管理者になります。管理者認証パスワードを変更する場合は、SupabaseのEdge Function Secretを更新してください。

## OpenStreetMap・住所検索の利用

地図タイルには標準のHTTPS URL（`https://tile.openstreetmap.org/{z}/{x}/{y}.png`）を使い、地図上にOpenStreetMap contributorsの帰属表示と地図の問題報告リンクを表示します。タイルの取得はLeafletによる表示範囲の通常操作に限り、事前取得・一括ダウンロードを行いません。ブラウザー標準のHTTPキャッシュを使い、キャッシュ無効化ヘッダーは送信しません。タイルのURLと帰属表示は `map-config.js` で管理します。

住所検索は利用者が検索フォームを送信したときだけ行います。Nominatimへの通信はSupabase Edge Function経由にし、DBでアプリ全体のリクエスト間隔を最低1秒に制限し、検索結果を30日間共有キャッシュします。ブラウザー内にも検索結果をキャッシュします。

Supabaseのプロジェクトに接続し、`supabase-schema.sql` を適用したうえで、公開サイトのオリジン（末尾の `/` なし）を設定してEdge Functionをデプロイしてください。

```sh
supabase secrets set ALLOWED_ORIGIN=https://your-public-domain.example
supabase secrets set NOMINATIM_SEARCH_URL=https://nominatim.openstreetmap.org/search
supabase functions deploy nominatim-search
```

`SUPABASE_URL` と `SUPABASE_SERVICE_ROLE_KEY` はSupabase Edge Functionsの環境変数を使用します。これらの秘密鍵をクライアントコードに記載しないでください。`ALLOWED_ORIGIN` は `map.html` を配信する実際のオリジンに置き換えてください。検索サービスを切り替える場合は、互換性のある検索APIのURLを `NOMINATIM_SEARCH_URL` に設定します。現在の設定は[OpenStreetMap Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)および[Nominatim Usage Policy](https://operations.osmfoundation.org/policies/nominatim/)に沿うようにしています。

## 招待リンクでの投稿

管理者でログインし、ヘッダーのリンクアイコンから招待リンクを発行します。リンクは無期限・複数回利用でき、発行したURLを受け取った人はアカウントを作らずに投稿できます。管理画面にはリンク名・発行日時・状態を表示し、いつでも無効化できます。発行URLは一度だけ表示されるため、その場でコピーして共有してください。安全のため、リンク発行にはHTTPSで公開されたサイトが必要です。

招待トークンはDBにハッシュで保存され、招待URLを開くと有効性をサーバーで確認します。招待経由の投稿もDB側の関数で検証して保存するため、通常の未ログイン投稿は許可されません。

スキーマ適用前の既存投稿には投稿者情報がないため、管理者のみ削除できます。

## 管理者の登録

ログイン済みアカウントが管理者パスワード認証に成功すると、すべての投稿の削除、管理ログの閲覧、招待リンクの発行と無効化、そして他の管理者への権限付与・剥奪が可能になります。ヘッダーの管理者アイコンから管理者一覧を確認できます。別の管理者を追加するには、相手のアカウント画面に表示されるユーザーIDを入力してください。自分自身の権限は画面から剥奪できず、最後の管理者は削除できないため、権限を失う事故を防げます。権限の確認と操作はSupabaseのRow Level Securityと管理者専用RPCでも制限されます。スキーマ変更後は、`supabase-schema.sql` をSupabase SQL Editorで再実行してください。
