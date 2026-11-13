# Crypto Portfolio Tracker

Modify from project https://github.com/your-quantguy/crypto-portfolio-tracker-oss

Self-hosted dashboard for tracking your whole crypto portfolio in one place:
on-chain wallets, centralized exchange accounts, perp/DEX positions, and manual
("custom") entries. Group accounts, sync balances on demand or on a daily
schedule, and keep per-account history for charts.

This is the open-source, self-hostable edition — multi-user local accounts, no
hosted billing, no email provider required.

## Features

- **On-chain wallets** — EVM via Zerion or [DeBank](https://cloud.debank.com/)
  (wallet tokens **plus** DeFi positions: lending, LPs, staking, perps);
  Solana / Sui / Cosmos via [CoinStats](https://openapi.coinstats.app/).
- **Exchanges & perp DEXs** — Binance · BingX · Bitget · OKX · Bybit · Gate ·
  Hyperliquid · Derive · Extended. Keys are entered in the UI and stored
  **encrypted at rest**.
- **Custom assets** — anything off-API (cold storage, OTC, vault shares), with
  optional live pricing from CoinMarketCap.
- **Groups, balance history, daily auto-sync**, and a per-asset/per-account
  breakdown.
- **Local multi-user auth** — signup/login with session cookies; passwords are
  scrypt-hashed. Sign up and you're in immediately (no email step).

## Stack

- **Backend** — Python 3.12, FastAPI, SQLAlchemy, SQLite (Postgres optional).
- **Frontend** — React 18 + TypeScript + Vite + React Router. English + 中文.
- **Deploy** — Docker Compose (backend Uvicorn on `:8000`, frontend Nginx on
  `:80` serving the SPA and proxying `/api/*`).

## Quick start (Docker Compose)

```bash
cp .env.example .env        # then fill in SECRETS_KEY + provider keys
# set REGISTRATION_ENABLED=true while creating your first user
docker compose up --build -d
```

App on http://localhost · API on http://localhost:8000.

At minimum set `SECRETS_KEY` (used to encrypt stored credentials). Generate one:

```bash
python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())'
```

Set `EVM_PORTFOLIO_PROVIDER=zerion` with `ZERION_API_KEY`, or
`EVM_PORTFOLIO_PROVIDER=debank` with `DEBANK_ACCESS_KEY`. Add
`COINSTATS_API_KEY` / `COINMARKETCAP_API_KEY` for the other data sources you
use. See [.env.example](.env.example) for everything else.

Registration is off by default. Set `REGISTRATION_ENABLED=true`, create the
user, then set it back to `false` and restart.

SQLite data is persisted to `./data` (mounted into the backend container).

## Production deployment on a small server

Set `PORTFOLIO_ORIGIN` in the server's `.env` and run `./deploy.sh` from the
production checkout. Use Docker with BuildKit and a Compose version that supports
`up --wait --wait-timeout`. The script builds the backend once for both the API
and the sync worker, then builds the frontend. The running app stays in place
while images are prepared. After that, the script takes its usual database
backup and starts the services.

The first backend build with this release still downloads Python packages.
Later builds on the same builder reuse the install layer when possible; if it
must run again, [BuildKit's pip cache mount](https://docs.docker.com/build/cache/optimize/#use-cache-mounts)
can reuse earlier downloads. Removing the builder cache makes the next build
cold again.

**To avoid compiling on the server entirely**, build the images on another
machine from a clean checkout of the commit being deployed. For example, for
an x86-64 Linux server, with write access to your registry:

```bash
prefix=ghcr.io/your-org/crypto-portfolio
revision=$(git rev-parse HEAD)
docker buildx build --platform linux/amd64 -t "$prefix-backend:$revision" --push ./backend
docker buildx build --platform linux/amd64 -t "$prefix-frontend:$revision" --push ./frontend
```

Then on the server, with read access to that registry:

```bash
./deploy.sh --prebuilt ghcr.io/your-org/crypto-portfolio
```

This mode pulls images tagged with the full Git commit after the fast-forward
update. If either tag is missing, deployment stops before replacing any service.
Use `linux/arm64` instead when building for an ARM64 server.

## Local development

```bash
# Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
SECRETS_KEY=$(python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())') \
SESSION_COOKIE_SECURE=false \
uvicorn app.main:app --reload          # http://localhost:8000
```

```bash
# Frontend
cd frontend
npm install
npm run dev                             # http://localhost:5173, proxies /api → :8000
```

Health check: `GET /api/health`. Set `ENABLE_API_DOCS=1` for `/docs`.

## How credentials work

- **Global provider keys** (`.env`): `ZERION_API_KEY`, `DEBANK_ACCESS_KEY`,
  `COINSTATS_API_KEY`, `COINMARKETCAP_API_KEY`. Used by the server to read
  public on-chain data.
- **Per-account exchange keys** (entered in the UI): API key/secret/passphrase
  and wallet address/private key, stored encrypted in the DB with `SECRETS_KEY`.
  The API only ever returns `has_*` booleans, never the secret values.

### Track exchange subaccounts

Open the master portfolio account's settings and enable **Include subaccounts**
for BingX, Bybit, or Binance. Use a master API key with read access to the
subaccounts. The switch defaults to off. Before enabling it, use **Set inactive**
on any subaccounts already tracked separately; otherwise those balances will
count twice in portfolio totals.

In the exchange account's holdings, **accounts** shows the master and each
subaccount with their wallets. **assets** shows one row per coin across those
wallets, without account labels. **Valuation only** contributes to equity and
appears under **All**, but not **Tokens**: the provider gave a value without
identifying a coin quantity. These views track wallet balances and equity;
they do not show individual open contracts.

| Exchange | Coverage with Include subaccounts |
| --- | --- |
| BingX | The [BingX API](https://bingx-api.github.io/docs-v3/) provides separate master and subaccount wallet overviews. Spot balances are itemized; other subaccount wallets report USDT-equivalent values. The master's USDT perpetual wallet is itemized when available. |
| Bybit | The master key reads the [member list](https://bybit-exchange.github.io/docs/v5/asset/total-members-assets) and each member's [asset overview](https://bybit-exchange.github.io/docs/v5/asset/balance/asset-overview). The overview endpoint does not support regional accounts. |
| Binance | Subaccount Spot, enabled cross-margin (net of borrowing), and enabled USD-M and COIN-M futures equity are included. Subaccount Funding, Earn and other products are outside this integration. |

If a required subaccount request fails, sync keeps the last successful snapshot.

### BingX coverage with Include subaccounts off

Choose **Exchange → BingX** and enter a read-only API key and secret. Allow
the backend server's IP if the key has an IP allowlist. No trading or withdrawal
permission, passphrase, exchange SDK, or BingX environment variable is needed.

- Tracks **Spot (free + locked)** and **USDT perpetual account equity**.
- Shows wallet assets and account equity, matching the existing Binance/Bybit
  presentation. Individual perpetual positions are not fetched or displayed.
  USDT is valued at USD 1.
- Excludes the separate Fund wallet, Earn, USDC/Coin-M/Standard Futures,
  copy/grid products, demo VST, and automatic subaccount discovery.
- Prices Spot holdings using BingX USDT quotes. A missing quote, required API
  failure, ambiguous missing USDT account, or unsupported negative equity fails
  sync and preserves the previous account snapshot, rather than saving a partial
  portfolio. History starts with the first successful local sync.

See [API sources](docs/bingx-api-research.md) and
[validation evidence and remaining live checks](docs/bingx-validation.md).

## Notes

- **Forgot password?** There's no email-based reset in the self-hosted edition.
  Reset it directly in the database, or delete and recreate the account.
- **Postgres:** set `DATABASE_URL` (e.g. `postgresql+psycopg://…`) to move off
  SQLite. Schema is created on startup; there's no migrations framework.
- **HTTPS:** the session cookie is Secure-by-default. For local HTTP set
  `SESSION_COOKIE_SECURE=false` (docker-compose already does). Flip it back on
  behind a TLS terminator.

## License

[MIT](LICENSE).
