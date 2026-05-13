/**
 * Standalone script: transfer NARA dari funding wallet ke sub-wallet yang
 * saldonya di bawah threshold tertentu.
 *
 * Usage:
 *   node fund.js                          # interaktif
 *   node fund.js 0.2                      # amount 0.2, threshold default 0.5, paralel 5
 *   node fund.js 0.2 0.5                  # amount 0.2, threshold 0.5, paralel 5
 *   node fund.js 0.2 0.5 10               # amount 0.2, threshold 0.5, paralel 10
 *   node fund.js 0.2 0 10                 # threshold 0 -> fund semua (ga ada yang di-skip)
 *
 * Arti parameter:
 *   amount    = berapa NARA yang dikirim ke tiap wallet target
 *   threshold = fund hanya wallet yang saldonya < threshold NARA
 *               (set 0 kalau mau fund semua wallet tanpa skip)
 *
 * Butuh .env di direktori kerja dengan:
 *   FUNDING_PRIVATE_KEY=<base58 private key>
 *   RPC_URL=https://mainnet-api.nara.build/   (opsional, ada defaultnya)
 *
 * Sumber daftar sub-wallet: ./data/accounts.json (format yg dipakai proyek ini).
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
const FUNDER_MIN_RESERVE_NARA = 0.01; // disisakan di funder untuk fee
const DEFAULT_AMOUNT_NARA = 0.2;
const DEFAULT_THRESHOLD_NARA = 0.5;
const DEFAULT_CONCURRENCY = 5;
const MAX_CONCURRENCY = 20;
const ACCOUNTS_FILE = path.resolve(process.cwd(), "data", "accounts.json");

// --- ANSI color helpers (no external deps) ---
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
  const decoded = bs58.decode(privateKey);
  return Keypair.fromSecretKey(decoded);
}

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_FILE)) {
    throw new Error(`File ${ACCOUNTS_FILE} gak ada. Generate dulu pakai auto/add-account.`);
  }
  const raw = fs.readFileSync(ACCOUNTS_FILE, "utf-8");
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.accounts)) {
    throw new Error(`Format accounts.json gak valid (expected { accounts: [...] }).`);
  }
  return parsed.accounts;
}

function parseArgs(argv) {
  const positional = [];
  const flags = new Set();
  for (const arg of argv.slice(2)) {
    if (arg.startsWith("--")) flags.add(arg);
    else positional.push(arg);
  }
  return { positional, flags };
}

async function main() {
  const { positional } = parseArgs(process.argv);

  const rpcUrl = process.env.RPC_URL || "https://mainnet-api.nara.build/";
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

  let accounts;
  try {
    accounts = loadAccounts();
  } catch (err) {
    console.log(color(`❌ ${err.message}`, c.red));
    process.exit(1);
  }

  if (accounts.length === 0) {
    console.log(color("⚠️  Belum ada sub-wallet di data/accounts.json", c.yellow));
    process.exit(0);
  }

  // --- Input amount (berapa NARA yang dikirim per wallet) ---
  let amount;
  if (positional[0]) {
    amount = parseFloat(positional[0]);
  } else {
    const ans = await ask(
      color(`💰 Amount per wallet (NARA) [default: ${DEFAULT_AMOUNT_NARA}]: `, c.cyan),
    );
    amount = ans ? parseFloat(ans) : DEFAULT_AMOUNT_NARA;
  }
  if (!amount || amount <= 0 || isNaN(amount)) {
    console.log(color("❌ Amount invalid", c.red));
    process.exit(1);
  }
  const amountLamports = Math.floor(amount * 10 ** NARA_DECIMALS);

  // --- Input threshold (fund hanya wallet yang saldo < threshold) ---
  let threshold;
  if (positional[1] !== undefined) {
    threshold = parseFloat(positional[1]);
  } else {
    const ans = await ask(
      color(
        `🎯 Fund hanya wallet dengan saldo < ? NARA [default: ${DEFAULT_THRESHOLD_NARA}, 0 = fund semua]: `,
        c.cyan,
      ),
    );
    threshold = ans === "" ? DEFAULT_THRESHOLD_NARA : parseFloat(ans);
  }
  if (isNaN(threshold) || threshold < 0) {
    console.log(color("❌ Threshold invalid", c.red));
    process.exit(1);
  }
  const thresholdLamports = Math.floor(threshold * 10 ** NARA_DECIMALS);

  // --- Input concurrency ---
  let concurrency;
  if (positional[2]) {
    concurrency = parseInt(positional[2], 10);
  } else if (positional[0]) {
    concurrency = DEFAULT_CONCURRENCY;
  } else {
    const ans = await ask(
      color(`⚡ Paralel berapa tx per batch? [default: ${DEFAULT_CONCURRENCY}]: `, c.cyan),
    );
    concurrency = ans ? parseInt(ans, 10) : DEFAULT_CONCURRENCY;
  }
  if (!concurrency || concurrency < 1 || isNaN(concurrency)) concurrency = 1;
  if (concurrency > MAX_CONCURRENCY) concurrency = MAX_CONCURRENCY;

  // --- Setup connection ---
  const connection = new Connection(rpcUrl, "confirmed");

  const thresholdLabel =
    threshold === 0 ? "fund semua (no threshold)" : `saldo < ${threshold} NARA`;
  console.log(
    color(
      `\n💸 Funding sub-wallets — ${amount} NARA each, target: ${thresholdLabel}, ${concurrency} parallel tx/batch\n`,
      c.bold,
    ),
  );

  // --- Ambil saldo semua sub-wallet ---
  const keypairs = accounts.map((a) => getKeypairFromBase58(a.privateKey));
  const pubkeys = keypairs.map((kp) => kp.publicKey);

  const balances = [];
  for (let i = 0; i < pubkeys.length; i += 100) {
    const batch = pubkeys.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(batch);
    for (const info of infos) {
      balances.push(info ? info.lamports : 0);
    }
  }

  // --- Filter target: hanya wallet yang saldo < threshold ---
  // Kalau threshold == 0, semua wallet di-fund (tidak ada yang di-skip).
  const targets = [];
  let skipped = 0;
  for (let i = 0; i < pubkeys.length; i++) {
    if (threshold > 0 && balances[i] >= thresholdLamports) {
      skipped++;
      continue;
    }
    targets.push(i);
  }

  if (targets.length === 0) {
    console.log(
      color(
        `  Nothing to fund. ${skipped} wallet sudah punya saldo >= ${threshold} NARA.\n`,
        c.gray,
      ),
    );
    return;
  }

  // --- Cek saldo funder ---
  const funderLamports = await connection.getBalance(funder.publicKey);
  const funderNara = funderLamports / 10 ** NARA_DECIMALS;
  const totalNeeded = amount * targets.length;

  console.log(color(`  Funder:       ${funder.publicKey.toBase58()}`, c.gray));
  console.log(color(`  Funder bal:   ${funderNara.toFixed(4)} NARA`, c.gray));
  console.log(
    color(`  Targets:      ${targets.length} wallet (skip ${skipped} yang saldo cukup)`, c.gray),
  );
  console.log(color(`  Total needed: ${totalNeeded.toFixed(4)} NARA (+ fees)\n`, c.gray));

  if (funderNara < totalNeeded + FUNDER_MIN_RESERVE_NARA) {
    console.log(
      color(
        `❌ Saldo funder kurang. Butuh ${(totalNeeded + FUNDER_MIN_RESERVE_NARA).toFixed(4)} NARA, ada ${funderNara.toFixed(4)}.`,
        c.red,
      ),
    );
    process.exit(1);
  }

  // --- Kirim per-batch paralel ---
  let successCount = 0;
  let failCount = 0;
  let totalSent = 0;

  for (let b = 0; b < targets.length; b += concurrency) {
    const chunk = targets.slice(b, b + concurrency);
    const { blockhash } = await connection.getLatestBlockhash("finalized");

    const sends = chunk.map(async (idx) => {
      const account = accounts[idx];
      const targetPk = pubkeys[idx];
      const currentBal = balances[idx] / 10 ** NARA_DECIMALS;

      try {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: funder.publicKey,
            toPubkey: targetPk,
            lamports: amountLamports,
          }),
        );
        tx.feePayer = funder.publicKey;
        tx.recentBlockhash = blockhash;
        tx.sign(funder);

        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        console.log(
          color(
            `  ✅ ${(account.name || "-").padEnd(14)} ${targetPk.toBase58().slice(0, 8)}…  bal=${currentBal.toFixed(4)} +${amount} NARA  (${sig.slice(0, 10)}…)`,
            c.green,
          ),
        );
        totalSent += amount;
        successCount++;
      } catch (err) {
        const msg = (err && err.message) || "unknown error";
        console.log(
          color(
            `  ❌ ${(account.name || "-").padEnd(14)} ${targetPk.toBase58().slice(0, 8)}…  — ${msg.slice(0, 60)}`,
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
      `\n📊 Sent ${totalSent.toFixed(4)} NARA — ${successCount} ok, ${failCount} failed, ${skipped} skipped\n`,
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
