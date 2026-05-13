/**
 * Standalone script: sweep (kumpulin) saldo dari akun-akun di file cadangan
 * ke funding wallet.
 *
 * Default: baca dari data/accounts-reserved.json
 * Mirror logic dari src/sweep.ts tapi targetnya file reserved.
 *
 * Usage:
 *   node sweep-reserved.cjs                     # interaktif (confirm y/N)
 *   node sweep-reserved.cjs --yes               # auto-confirm
 *   node sweep-reserved.cjs --dry-run           # preview aja, ga kirim tx
 *   node sweep-reserved.cjs --file=data/accounts.json   # custom source file
 *   node sweep-reserved.cjs --keep=0.01         # sisa yang disimpen per wallet (default 0.005)
 *   node sweep-reserved.cjs --concurrency=10    # paralel tx per batch (default 5)
 *
 * Butuh .env dengan FUNDING_PRIVATE_KEY.
 */

"use strict";

require("dotenv/config");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { Connection, Keypair, Transaction, SystemProgram } = require("@solana/web3.js");
const bs58 = require("bs58");

// --- Konstanta ---
const NARA_DECIMALS = 9;
const DEFAULT_KEEP_NARA = 0.005; // sisa buat bayar fee + rent
const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 20;
const DEFAULT_SOURCE = path.resolve(process.cwd(), "data", "accounts-reserved.json");

// --- ANSI colors ---
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

function ask(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

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
  const { flags, kv } = parseArgs(process.argv);

  const sourceFile = kv.file ? path.resolve(process.cwd(), kv.file) : DEFAULT_SOURCE;
  const keepNara = kv.keep ? parseFloat(kv.keep) : DEFAULT_KEEP_NARA;
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, kv.concurrency ? parseInt(kv.concurrency, 10) : DEFAULT_CONCURRENCY),
  );

  if (isNaN(keepNara) || keepNara < 0) {
    console.log(color("❌ --keep invalid", c.red));
    process.exit(1);
  }
  const keepLamports = Math.floor(keepNara * 10 ** NARA_DECIMALS);

  // --- Load funder ---
  const fundingPk = process.env.FUNDING_PRIVATE_KEY;
  if (!fundingPk) {
    console.log(color("❌ FUNDING_PRIVATE_KEY gak ada di .env", c.red));
    process.exit(1);
  }
  let funder;
  try {
    funder = getKeypairFromBase58(fundingPk);
  } catch (err) {
    console.log(color(`❌ FUNDING_PRIVATE_KEY invalid: ${err.message}`, c.red));
    process.exit(1);
  }

  // --- Load source file ---
  if (!fs.existsSync(sourceFile)) {
    console.log(color(`❌ File ga ada: ${sourceFile}`, c.red));
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
    console.log(color(`⚠️  ${sourceFile} kosong atau tidak berisi 'accounts'.`, c.yellow));
    return;
  }

  const rpcUrl = process.env.RPC_URL || "https://mainnet-api.nara.build/";
  const connection = new Connection(rpcUrl, "confirmed");

  console.log(
    color(
      `\n💸 Sweep ${parsed.accounts.length} akun dari ${path.basename(sourceFile)} → ${funder.publicKey.toBase58().slice(0, 12)}...\n`,
      c.bold,
    ),
  );
  console.log(color(`  Source:  ${sourceFile}`, c.gray));
  console.log(color(`  Funder:  ${funder.publicKey.toBase58()}`, c.gray));
  console.log(color(`  Keep:    ${keepNara} NARA per wallet`, c.gray));
  console.log(color(`  Paralel: ${concurrency} tx per batch\n`, c.gray));

  // --- Ambil saldo semua sub-wallet ---
  const keypairs = parsed.accounts.map((a) => getKeypairFromBase58(a.privateKey));
  const pubkeys = keypairs.map((kp) => kp.publicKey);

  const balances = [];
  for (let i = 0; i < pubkeys.length; i += 100) {
    const batch = pubkeys.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(batch);
    for (const info of infos) {
      balances.push(info ? info.lamports : 0);
    }
  }

  // --- Filter sweepable ---
  const sweepable = [];
  for (let i = 0; i < balances.length; i++) {
    if (balances[i] > keepLamports) {
      sweepable.push({ idx: i, amount: balances[i] - keepLamports });
    }
  }

  if (sweepable.length === 0) {
    console.log(color(`  Nothing to sweep (semua wallet saldo <= ${keepNara} NARA).\n`, c.gray));
    return;
  }

  // --- Preview ---
  console.log(color(`📋 Akan di-sweep (${sweepable.length} wallet):\n`, c.bold));
  console.log("  " + "Name".padEnd(14) + "Wallet".padEnd(16) + "Current".padEnd(14) + "→ Sweep");
  console.log("  " + "─".repeat(65));
  let totalToSweep = 0;
  for (const { idx, amount } of sweepable) {
    const account = parsed.accounts[idx];
    const currentBal = balances[idx] / 10 ** NARA_DECIMALS;
    const sweepBal = amount / 10 ** NARA_DECIMALS;
    totalToSweep += sweepBal;
    console.log(
      "  " +
        (account.name || "-").padEnd(14) +
        (pubkeys[idx].toBase58().slice(0, 12) + "…").padEnd(16) +
        color((currentBal.toFixed(4) + " NARA").padEnd(14), c.yellow) +
        color(sweepBal.toFixed(4) + " NARA", c.green),
    );
  }
  console.log("  " + "─".repeat(65));
  console.log(color(`  Total: ${totalToSweep.toFixed(4)} NARA\n`, c.bold));

  if (flags.has("dry-run")) {
    console.log(color("  (dry-run — tidak ada tx yang dikirim)\n", c.gray));
    return;
  }

  if (!flags.has("yes")) {
    const ans = await ask(color("  Lanjutkan sweep? (y/N): ", c.cyan));
    if (ans.toLowerCase() !== "y") {
      console.log(color("  Dibatalkan.\n", c.gray));
      return;
    }
  }

  // --- Execute ---
  let totalSent = 0;
  let successCount = 0;
  let failCount = 0;

  for (let b = 0; b < sweepable.length; b += concurrency) {
    const chunk = sweepable.slice(b, b + concurrency);
    const { blockhash } = await connection.getLatestBlockhash("finalized");

    const sends = chunk.map(async ({ idx, amount }) => {
      const kp = keypairs[idx];
      const account = parsed.accounts[idx];
      const sendNara = amount / 10 ** NARA_DECIMALS;

      try {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: funder.publicKey,
            lamports: amount,
          }),
        );
        tx.feePayer = kp.publicKey;
        tx.recentBlockhash = blockhash;
        tx.sign(kp);

        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        console.log(
          color(
            `  ✅ ${(account.name || "-").padEnd(14)} ${sendNara.toFixed(4)} NARA  (${sig.slice(0, 10)}…)`,
            c.green,
          ),
        );
        totalSent += sendNara;
        successCount++;
      } catch (err) {
        const msg = (err && err.message) || "unknown";
        console.log(
          color(
            `  ❌ ${(account.name || "-").padEnd(14)} — ${msg.slice(0, 60)}`,
            c.red,
          ),
        );
        failCount++;
      }
    });

    await Promise.all(sends);
  }

  console.log(
    color(
      `\n📊 Swept ${totalSent.toFixed(4)} NARA — ${successCount} ok, ${failCount} failed\n`,
      c.bold,
    ),
  );

  await new Promise((r) => setTimeout(r, 3000));
  const finalBal = await connection.getBalance(funder.publicKey);
  console.log(
    color(
      `  Funding wallet balance: ${(finalBal / 10 ** NARA_DECIMALS).toFixed(4)} NARA\n`,
      c.cyan,
    ),
  );
}

main().catch((err) => {
  console.error(color(`Fatal: ${err.message || err}`, c.red));
  process.exit(1);
});
