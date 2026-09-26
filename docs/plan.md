# eth-global: Trustless Oripa on Sui（ETHGlobal Tokyo 2026 / Sui「DeFi & Payments」）

## Context
- ETHGlobal Tokyo 2026 の提出物（**締切 2026-09-27 09:00 JST**、Classic「From Scratch」、狙いは Sui DeFi & Payments $5k）。
- 課題: 日本のオンラインオリパは「当たりを抜く・口数を足す・還元率の虚偽表示・当たっても送られない」の不信があり、2026-09-17 に大手 5 社が提訴された。海外のオンチェーンガチャ（Courtyard / Collector Crypt / Phygitals）は確率型＋在庫補充で、プールの中身や乱数鍵は運営を信じる前提。
- 作るもの: **その場で引ける有限プール（オリパ型）を、運営を信じなくていい形で Sui 上に作る**。
  1. 景品と口数は作成時に固定し、変更する関数を作らない。パッケージは immutable にする
  2. 抽選は購入ごとに `sui::random`。シードも並び順も存在しない
  3. 残り在庫・還元率・次の 1 回の期待値は、オンチェーンの状態から誰でも計算できる
  4. 当たったのに発送されなければ、運営が預けた担保から自動で支払う（Payments / Vault の要素）
  5. 余力があれば「締切で一斉割り当て」モード（グループブレイク風、完売不要）
- ユーザー決定: UI は英語（カード名だけ日本語）。決済は **Sui テストネットの USDC**（Circle、`0xa1ec7fc00a6f40db9693ad1415d0c193ad3906494428cf252621037bd7117e29::usdc::USDC`）。画像と相場は psa-data のスニダンのデータを流用する（ハッカソン専用）。

## 前提と環境（探索で確認済み）
- `sui` CLI は Homebrew の 1.48.0（2025-05）で古い → `brew upgrade sui`。
- 既存の `~/.sui/sui_config/client.yaml` は mainnet が active で、実キーが入っている → **触らない**。eth-global 専用の設定 `eth-global/.sui/client.yaml`（gitignore）をテストネットで新規作成し、使い捨ての新しいアドレスを作る。CLI は毎回 `--client.config eth-global/.sui/client.yaml` を付ける（Makefile に閉じ込める）。
- Node v22 / npm 10 / yarn 4（Volta）。pnpm は無い → npm を使う。
- ポート 3000 は saturnbird が使用中 → フロントは 5173。
- gh はログイン済み（push はユーザー確認後）。
- 既存の Move は `~/Code/sui-bot/alpha_guard/`（edition 2024）だけ。Move.toml の書き方の参考にする。

## デモの縮尺
- Circle の faucet は 20 USDC / 2 時間 / アドレス → **オンチェーンの金額は実際の相場の 1/1000**（固定ドル円 150 で円 → USD → ÷1000）。
  - 例: ¥243,000 のカード → $1,620 → 1.62 USDC
- 画面は「相場 ¥ / デモ額 USDC」を並べて表示する。還元率と期待値はオンチェーンの USDC の値から計算する（縮尺は全部同じなので比率は変わらない）。

## ディレクトリ構成（新規 `~/Code/claude/eth-global/`、独立した git リポジトリ）
```
eth-global/
  README.md                 # 課題・トラストレスの範囲・構成・AI 利用の明記・データの出典と注意
  Makefile                  # sui の専用 config 付きコマンド、test / deploy / seed / dev
  docs/plan.md              # この計画のコピー（ETHGlobal の規約: 計画ファイルも提出物に含める）
  move/oripa/Move.toml
  move/oripa/sources/pool.move
  move/oripa/tests/pool_tests.move
  scripts/export_cards.py   # psa-data → カード JSON + 画像コピー + プール構成
  scripts/deploy.ts         # publish → UpgradeCap を make_immutable
  scripts/seed.ts           # create_pool（景品固定 + USDC 担保）→ frontend の設定を書き出し
  frontend/                 # Vite + React + TS（`npm create @mysten/dapp` の雛形から）
  .gitignore                # .sui/, node_modules, build, frontend/public/cards/（画像はコミットしない）
```

## スマートコントラクト（`move/oripa/sources/pool.move`、edition 2024）
**型**（ガスを一定にするため、景品と引換券は固定長のフィールドだけにする）
- `Prize has store, copy, drop { prize_id: u64, card_id: u64 /*スニダン ID*/, cert: u64 /*PSA 番号（デモ値）*/, value: u64, tier: u8 }`
- `Pool<phantom T> has key`
  - `operator`、`price: u64`、`total_count`、`total_value`
  - `remaining: vector<Prize>`、`remaining_value`
  - `metadata_hash: vector<u8>`（カード名・画像などオフチェーンのメタデータ JSON の sha256 をコミット）
  - `sales: Balance<T>`、`collateral: Balance<T>`、`collateral_bps: u16`
  - `redeem_window_ms`、`outstanding: u64`
  - `mode`（0 = 即時、1 = 一斉）と一斉モード用のフィールド
- `AdminCap has key, store { pool_id }`
- `Pull has key, store { pool_id, prize: Prize, drawn_at_ms }`: 引いた景品の引換券。`sui::display` でウォレットに画像を出す（`{prize.card_id}` を URL テンプレに差し込む）
- `Redemption has key`（共有）`{ pool_id, owner, prize, deadline_ms, shipped: bool, tracking: String }`
- イベント: `PoolCreated` / `Drawn { pool_id, drawer, prize, remaining }` / `RedeemRequested` / `Shipped` / `CollateralClaimed`

**関数**
- `create_pool<T>(price, card_ids, certs, values, tiers: vector<…>, metadata_hash, collateral: Coin<T>, collateral_bps, redeem_window_ms, ctx)`
  - 担保 ≥ total_value × bps を assert
  - Pool を share し、AdminCap を運営に渡す
- `entry fun draw<T>(pool, payment: Coin<T>, r: &Random, clock, ctx)` — **private entry**（`public` にしない = 結果を見て取り消す攻撃を防ぐ）
  - 支払額 == price を assert
  - `new_generator` → `generate_u64_in_range(0, len-1)` → `swap_remove` → Pull を sender に transfer
  - **どの景品が出ても処理とオブジェクトの大きさが同じ** → ガスの上限で外れだけ失敗させる攻撃ができない
- `request_redeem(pull, pool, clock)`: Pull を燃やして共有の Redemption を作る。`outstanding += 1`
- `mark_shipped(cap, redemption, tracking)`: 運営のみ
- `confirm_received(redemption)`: 持ち主のみ。Redemption を消し、`outstanding -= 1`
- `claim_collateral(redemption, pool, clock)`: 持ち主。未発送かつ期限切れなら `value × bps / 10000` を担保から払う
- `withdraw_sales(cap, pool)`: 売上はいつでも引き出せる
- `withdraw_collateral(cap, pool)`: 残り 0 かつ `outstanding == 0` の時だけ
- **景品・口数・価格を変更する関数は作らない**
- （余力）一斉モード:
  - `create_batch_pool(… sale_end_ms)` → `buy_spot`（Spot を発行）
  - `entry fun settle(pool, r, clock)`: 締切後、誰でも呼べる。売れた口数ぶんだけ `shuffle` で一斉に割り当て、余った景品は運営に戻す
  - `open_spot(spot, pool)` → Pull

**テスト**（`tests/pool_tests.move`、`test_scenario` + `random::create_for_testing` / `update_randomness_state_for_testing`、`sui move test`。テスト用のコインは `sui::sui::SUI`）
- N 回引くと、全景品がちょうど 1 回ずつ出る
- `remaining_value` が正しく減る
- 金額違い・売り切れで abort する
- 期限切れで担保から `value × bps` が払われる
- 発送済みなら請求できない
- `outstanding > 0` の間は担保を引き出せない
- （一斉モード）重複なく割り当てられ、余りは運営に戻る

## データの書き出し（`scripts/export_cards.py`、psa-data を読むだけ）
- 入力
  - 価格: `psa-data/data/snkrdunk/psa10_prices_2026-09-26.json`
    - `psa10_cleaned_price` / `psa10_cleaned_date` / `psa10_points_count` / `favorite_count` / `cond_a_cleaned_price`
    - `*_raw_*` と chart は 5/16 で止まっているので使わない
  - 画像: `psa-data/data/images/snkrdunk/{snkrdunk_id}.webp`（ローカル、1000x730・余白付き）
  - 画像 URL（予備）: `all_products_2026-09-23.json` の `image_url`
- タイトルの分解は `psa-data/scripts/build_cards_api.py` の `extract_card_name` / `extract_rarity` / `extract_card_number_full` / `extract_set_name_ja` を import して使う。失敗したら title をそのまま使う
- 条件: `psa10_cleaned_date >= 2026-08-15`、`points_count >= 20`、ローカル画像あり。各帯を `favorite_count` の多い順に並べる
- 40 口の構成（目安）

  | 帯 | 枚数 | 価格の目安 | 例 |
  |---|---|---|---|
  | S | 3 | PSA10 ¥100k 以上 | 93379 ギラティナV SA、91155 ピカチュウV S8a-G、704401 メガリザードンXex SAR |
  | A | 5 | PSA10 ¥49〜75k | 91156、131236、455596、93015、120748 |
  | B | 8 | PSA10 ¥4〜6k | — |
  | C | 24 | 素の状態（`cond_a_cleaned_price`）¥1,000〜1,600 | — |

  - 価格 = 景品総額 ÷ (40 × 0.95) を丸めたもの（還元率 95% 前後）
- 出力
  - `frontend/public/cards/{id}.webp`（コピー、gitignore）
  - `frontend/src/data/cards.json`（id・名前・セット・番号・レア・相場 ¥・帯）
  - `scripts/pool_spec.json`（オンチェーンに渡す値 = USDC 縮尺、metadata_hash）

## デプロイとシード（`scripts/*.ts`、`npx tsx`、`@mysten/sui`）
1. `brew upgrade sui`
2. `sui client --client.config .sui/client.yaml` でテストネットの環境と新しいアドレスを作る
3. **ユーザー作業**
   - https://faucet.sui.io で SUI（ガス）を入れる
   - https://faucet.circle.com で USDC 20 を入れる
4. `deploy.ts`: `sui move build` の出力を publish → `package::make_immutable(UpgradeCap)`
5. `seed.ts`: 担保の USDC を分けて `create_pool` → `frontend/src/config/deployed.json` に packageId / poolId / coin type / adminCapId を書く
   - 鍵は専用の keystore（テストネット専用・gitignore）から読む

## フロントエンド（`frontend/`、英語 UI、port 5173）
- 雛形: `npm create @mysten/dapp`（今の dapp-kit / @mysten/sui のバージョンに合わせるため）
- ネットワーク: testnet。ウォレット: Slush などの dapp-kit 対応ウォレット
- 画面は 1 ページで、タブを 4 つ置く
  1. **Pool**
     - 上部に数字を並べる: 残り口数・残りの S 帯・残り総額・還元率（残り）・次の 1 回の期待値（価格比 %）
     - その下に景品のグリッド（引かれたものはグレーアウト）
     - **Draw** ボタン: PTB で `splitCoins(USDC)` → `draw`
     - 引いた後は、カードがめくれる演出を帯ごとに変え、Suiscan の Tx へのリンクを出す
     - 右側に直近の `Drawn` イベントを流す（2 秒ごとに取得）
  2. **My Pulls**: 手持ちの Pull → Redeem → 状態・期限のカウントダウン → 期限切れなら Claim collateral
  3. **Operator**: AdminCap を持っている時だけ表示。Mark shipped（追跡番号）、売上の引き出し
  4. **Verify**
     - パッケージが immutable であること（UpgradeCap を燃やした Tx へのリンク）
     - モジュールの全関数の一覧（RPC の normalized module から取得）→「景品を変える関数は無い」を見せる
     - `cards.json` の sha256 とオンチェーンの `metadata_hash` が一致すること
     - 乱数が `0x8` から来ていること
- 画像は `object-fit: contain` で余白を処理する

## 作業の順番（こまめに commit。ETHGlobal は 1 回だけの巨大 commit を失格にし得る）
1. `git init`、雛形、.gitignore、README の骨組み、`docs/plan.md`
2. Move 本体（即時モード＋担保）とテスト → `sui move test` が通る
3. `export_cards.py` → カードと構成を確認
4. テストネットへのデプロイとシード（faucet はユーザー作業）
5. フロント: Pool と Draw → My Pulls と担保 → Verify → Operator
6. README 完成（AI 利用の明記: Claude Code で書いた範囲、データの出典とハッカソン専用である旨、トラストレスで残る信頼 = 現物の保管）
7. （余力）一斉モード
8. ルートの `~/Code/claude/CLAUDE.md` のプロジェクト一覧に eth-global を追記
9. GitHub への push とデモ動画（2〜4 分）はユーザーと確認してから

## 検証
- `make test`（= `sui move test`）が全部通る
- テストネットで実際に操作して、次の 6 点を確かめる
  1. Draw を 3 回引くと、残り・還元率・期待値がその場で変わる
  2. 同じ景品が 2 回出ない
  3. Suiscan で Tx に `0x8`（Random）が入っている
  4. Redeem → 期限切れ → Claim collateral で USDC が戻る
  5. Verify タブで metadata_hash の一致と immutable が表示される
  6. Operator の Mark shipped の後は、担保を請求できない
- Chrome で 5173 を開いて、全タブを通しで操作する
