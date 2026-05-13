/**
 * Standalone script: cek saldo semua akun di file cadangan
 * (data/accounts-reserved.json).
 *
 * Mirror format dari `npm start -- balances` tapi source-nya file reserved.
 *
 * Usage:
 *   node balances-reserved.cjs                         # default: data/accounts-reserved.json
 *   node balances-reserved.cjs --file=data/accounts.json   # custom source
 *   node balances-reserved.cjs --sort=balance          # sort by balance desc
 *   node balances-reserved.cjs --sort=name             # sort by name asc
 *   node balances-reserved.cjs --min=1                 # filter: cuma yg saldo >= 1 NARA
 *
 * Butuh .env dengan FUNDING_PRIVATE_KEY (untuk compare ke funder) — opsional.
 */

"use strict";

require("dotenv/config");
const fs = require("fs");
const path = require("path");
const { Connection, Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");

const NARA_DECIMALS = 9;
const DEFAULT_SOURCE = path.resolve(process.cwd(), "data", "accounts-reserved.json");

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
};
const color = (s, col) => `${col}${s}${c.reset}`;

function getKeypairFromBase58(privateKey) {
  return Keypair.fromSecretKey(bs58.decode(privateKey));
}

function parseArgs(argv) {
  const flags = new Set();
  const kv = {};
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--") && arg.includes("=")) {
      const [k, v] = arg.slice(2).split("=");
      kv[k] = v;
    } else if (arg.startsWith("--")) {
      flags.add(arg.slice(2));
    }
  }
  return { flags, kv };
}

async function main() {
  const { kv } = parseArgs(process.argv);

  const sourceFile = kv.file ? path.resolve(process.cwd(), kv.file) : DEFAULT_SOURCE;
  const minNara = kv.min ? parseFloat(kv.min) : 0;
  const sortBy = kv.sort || "name"; // name | balance

  if (!fs.existsSync(sourceFile)) {
    console.log(color(`❌ File ga ada: ${sourceFile}`, c.red));
    console.log(color(`   Jalanin 'node separate.cjs 1' dulu buat bikin file reserved.\n`, c.gray));
    process.exit(1);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(sourceFile, "utf-8"));
  } catch (err) {
    console.log(color(`❌ JSON invalid: ${err.message}`, c.red));
    process.exit(1);
  }
  if (!parsed || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
    console.log(color(`⚠️  ${sourceFile} kosong (0 akun).\n`, c.yellow));
    return;
  }

  const rpcUrl = process.env.RPC_URL || "https://mainnet-api.nara.build/";
  const connection = new Connection(rpcUrl, "confirmed");

  console.log(
    color(
      `\n💰 Balance Check — ${parsed.accounts.length} reserved wallets\n`,
      c.bold,
    ),
  );
  console.log(color(`  Source: ${sourceFile}`, c.gray));
  console.log(color(`  RPC:    ${rpcUrl}\n`, c.gray));

  // Ambil saldo batch 100
  const pubkeys = parsed.accounts.map((a) => getKeypairFromBase58(a.privateKey).publicKey);

  // Kalau funding PK ada, ikutan dicek biar bisa dibandingin
  let funderPub = null;
  try {
    if (process.env.FUNDING_PRIVATE_KEY) {
      funderPub = getKeypairFromBase58(process.env.FUNDING_PRIVATE_KEY).publicKey;
      pubkeys.push(funderPub);
    }
  } catch {
    funderPub = null;
  }

  const balancesLamports = [];
  for (let i = 0; i < pubkeys.length; i += 100) {
    const batch = pubkeys.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(batch);
    for (const info of infos) {
      balancesLamports.push(info ? info.lamports : 0);
    }
  }

  // Bangun rows
  const rows = parsed.accounts.map((a, i) => {
    const wallet = (a.walletAddress ||
      getKeypairFromBase58(a.privateKey).publicKey.toBase58());
    return {
      name: a.name || "-",
      agentId: a.agentId || "-",
      wallet,
      balance: balancesLamports[i] / 10 ** NARA_DECIMALS,
    };
  });

  // Filter
  const filtered = rows.filter((r) => r.balance >= minNara);

  // Sort
  if (sortBy === "balance") {
    filtered.sort((a, b) => b.balance - a.balance);
  } else {
    filtered.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Print tabel
  console.log(
    "  " +
      "Name".padEnd(15) +
      "Agent ID".padEnd(25) +
      "Wallet".padEnd(16) +
      "Balance",
  );
  console.log("  " + "─".repeat(70));

  let total = 0;
  for (const r of filtered) {
    total += r.balance;
    const balStr = r.balance.toFixed(4) + " NARA";
    const col = r.balance >= 1 ? c.green : r.balance > 0 ? c.yellow : c.red;
    console.log(
      "  " +
        r.name.padEnd(15) +
        r.agentId.padEnd(25) +
        (r.wallet.slice(0, 14) + "…").padEnd(16) +
        color(balStr, col),
    );
  }

  console.log("  " + "─".repeat(70));

  if (funderPub) {
    const funderNara = balancesLamports[balancesLamports.length - 1] / 10 ** NARA_DECIMALS;
    console.log(
      "  " +
        color("FUNDING".padEnd(15), c.cyan) +
        color("—".padEnd(25), c.cyan) +
        color((funderPub.toBase58().slice(0, 14) + "…").padEnd(16), c.cyan) +
        color(funderNara.toFixed(4) + " NARA", c.cyan),
    );
  }

  console.log(
    color(
      `\n  Reserved total: ${total.toFixed(4)} NARA (${filtered.length}/${rows.length} akun${minNara > 0 ? `, filter >= ${minNara}` : ""})`,
      c.bold,
    ),
  );
  if (funderPub) {
    const funderNara = balancesLamports[balancesLamports.length - 1] / 10 ** NARA_DECIMALS;
    console.log(
      color(`  Funding wallet: ${funderNara.toFixed(4)} NARA`, c.bold),
    );
  }
  console.log();
}

main().catch((err) => {
  console.error(color(`Fatal: ${err.message || err}`, c.red));
  process.exit(1);
});
