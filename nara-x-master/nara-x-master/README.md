# NARA-X

Batch automation tool for [Nara.build](https://nara.build) — register agents, bind Twitter, stake, post, claim campaigns, and farm NARA tokens at scale.

## Features

- **Auto Mode** — Generate N accounts + run full pipeline with parallel workers
- **Parallel Processing** — Configurable concurrency (1-20 workers)
- **Batch Balance Check** — Single RPC call for all wallets (fast)
- **Sweep** — Collect all NARA from sub-wallets to main wallet (parallel TX)
- **Inbox** — Check DMs + auto-claim codes (with dedup tracking)
- **Dragon Ball Farm** — Automated daily Dragon Ball collection
- **Interactive Menu** — Clean TUI dashboard with real-time progress

## Requirements

- Node.js 18+
- npm or pnpm
- A funded NARA wallet (main/funding wallet)

## Installation

```bash
git clone https://github.com/pfrfrfr/nara-x.git
cd nara-x
npm install
```

## Configuration

1. Open `src/config.ts` and set your `REFERRAL_AGENT_ID` (optional)

2. Open `src/sweep.ts` and `src/batch.ts` — replace `FUNDING_PRIVATE_KEY` with your main wallet's private key (base58)

3. Create the data directory:
```bash
mkdir data
```

## Usage

### Interactive Menu

```bash
npm start
```

Shows dashboard with options:
1. 🚀 **Auto** — Generate N accounts + run parallel pipeline
2. 🔄 **Batch Pending** — Run pending accounts with concurrency
3. 📬 **Inbox** — Check DMs + claim codes
4. 💸 **Sweep** — Send all NARA to main wallet
5. 💰 **Balances** — Check all wallet balances
6. 📊 **Status** — View account statuses

### CLI Commands

```bash
# Auto mode: generate 10 accounts, 5 parallel workers
npm start -- auto 10,5

# Run all pending accounts
npm start -- batch

# Check inbox for all accounts
npm start -- inbox

# Sweep all NARA to main wallet
npm start -- sweep

# Check balances
npm start -- balances

# Dragon Ball farm
npm start -- farm

# Import accounts from file
npm start -- import

# Generate a new wallet
npm start -- gen-wallet

# Add account manually
npm start -- add-account <privateKey> <twitterUsername> <agentId>
```

## Pipeline Steps (per account)

1. Fund wallet (0.2 NARA from main)
2. Register agent on-chain
3. Bind Twitter username
4. Stake 0.01 NARA
5. Create post via AgentX
6. Submit campaign
7. Claim Dragon Ball (daily)

## File Structure

```
src/
├── index.ts        # Entry point + interactive menu
├── config.ts       # Config, types, RPC connection
├── auto.ts         # Auto-generate accounts + run
├── batch.ts        # Parallel batch processor + UI
├── ui.ts           # Real-time terminal dashboard
├── register.ts     # On-chain agent registration
├── twitter.ts      # Twitter bind + tweet templates
├── inbox.ts        # DM inbox check + code claim
├── sweep.ts        # Sweep NARA to main wallet
├── dragonball.ts   # Dragon Ball daily farm
└── accounts.ts     # Account management utilities
data/
├── accounts.json       # All account data (auto-generated)
└── claimed-codes.json  # Dedup tracking for claimed codes
```

## Notes

- Private keys are stored in `data/accounts.json` — keep this file secure
- The `data/` directory is gitignored
- Default RPC: `https://mainnet-api.nara.build/`
- Sweep keeps 0.005 NARA in each sub-wallet for rent

## License

Private — not for redistribution.
