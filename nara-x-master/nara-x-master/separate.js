/**
 * Standalone script: pisahin akun dari data/accounts.json berdasarkan saldo.
 *
 * Akun dengan saldo >= threshold dipindah ke data/accounts-reserved.json
 * biar pas script utama jalan (misal dragon ball farm), akun "gemuk" itu
 * ga kedetect dan ga ikut di-proses.
 *
 * Usage:
 *   node separate.js                  # interaktif
 *   node separate.js 1                # pindah akun dengan saldo >= 1 NARA
 *   node separate.js 0.5              # pindah akun dengan saldo >= 0.5 NARA
 *   node separate.js 1 --dry-run      # preview aja, ga nulis file
 *
 *   node separate.js --restore        # balikin SEMUA dari reserved ke accounts.json
 *   node separate.js --list           # tampilin isi reserved sekarang
 *
 * Butuh .env dengan RPC_URL (opsional) dan file data/accounts.json.
 *
 * Sebelum overwrite, accounts.json otomatis di-backup ke
 * data/accounts.json.bak-<timestamp>
 */

"use strict";

require("dotenv/config");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { Connection } = require("@solana/web3.js");
const bs58 = require("bs58");
const { Keypair } = require("@solana/web3.js");

// --- Konstanta ---
const NARA_DECIMALS = 9;
const DEFAULT_THRESHOLD_NARA = 1;
const DATA_DIR = path.resolve(process.cwd(), "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const RESERVED_FILE = path.join(DATA_DIR, "accounts-reserved.json");

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

function readJsonOr(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`File ${filePath} invalid JSON: ${err.message}`);
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function backupFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const bakPath = `${filePath}.bak-${ts}`;
  fs.copyFileSync(filePath, bakPath);
  return bakPath;
}

function getKeypairFromBase58(privateKey) {
  return Keypair.fromSecretKey(bs58.decode(privateKey));
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

// ---------------- Modes ----------------

async function modeList() {
  const reserved = readJsonOr(RESERVED_FILE, { accounts: [] });
  if (!reserved.accounts || reserved.accounts.length === 0) {
    console.log(color("  File cadangan kosong (belum ada akun yang dipindah).\n", c.gray));
    return;
  }
  console.log(color(`\n📦 accounts-reserved.json (${reserved.accounts.length} akun):\n`, c.bold));
  console.log("  " + "Name".padEnd(14) + "Agent ID".padEnd(22) + "Wallet");
  console.log("  " + "─".repeat(70));
  for (const a of reserved.accounts) {
    const wallet = a.walletAddress || getKeypairFromBase58(a.privateKey).publicKey.toBase58();
    console.log(
      "  " +
        (a.name || "-").padEnd(14) +
        (a.agentId || "-").padEnd(22) +
        wallet.slice(0, 16) + "…",
    );
  }
  console.log();
}

async function modeRestore(flags) {
  const reserved = readJsonOr(RESERVED_FILE, { accounts: [] });
  const main = readJsonOr(ACCOUNTS_FILE, { accounts: [] });

  if (!reserved.accounts || reserved.accounts.length === 0) {
    console.log(color("  File cadangan kosong, tidak ada yang di-restore.\n", c.gray));
    return;
  }

  const existingNames = new Set(main.accounts.map((a) => a.name));
  const existingAgentIds = new Set(main.accounts.map((a) => a.agentId));
  const toAdd = [];
  const skipped = [];
  for (const a of reserved.accounts) {
    if (existingNames.has(a.name) || existingAgentIds.has(a.agentId)) {
      skipped.push(a);
    } else {
      toAdd.push(a);
    }
  }

  console.log(
    color(
      `\n♻️  Akan restore ${toAdd.length} akun dari reserved ke accounts.json`,
      c.bold,
    ),
  );
  if (skipped.length > 0) {
    console.log(color(`  ⚠️  ${skipped.length} akun di-skip karena name/agentId bentrok`, c.yellow));
  }

  if (flags.has("--dry-run")) {
    console.log(color("  (dry-run — tidak ada file yang diubah)\n", c.gray));
    return;
  }

  const ans = await ask(color("  Lanjutkan? (y/N): ", c.cyan));
  if (ans.toLowerCase() !== "y") {
    console.log(color("  Dibatalkan.\n", c.gray));
    return;
  }

  const bakMain = backupFile(ACCOUNTS_FILE);
  const bakReserved = backupFile(RESERVED_FILE);

  main.accounts.push(...toAdd);
  writeJson(ACCOUNTS_FILE, main);

  // Sisain yang skipped doang di reserved
  writeJson(RESERVED_FILE, { accounts: skipped });

  console.log(color(`\n✅ ${toAdd.length} akun di-restore ke accounts.json`, c.green));
  if (bakMain) console.log(color(`  backup: ${bakMain}`, c.gray));
  if (bakReserved) console.log(color(`  backup: ${bakReserved}`, c.gray));
  console.log();
}

async function modeSeparate(positional, flags) {
  const main = readJsonOr(ACCOUNTS_FILE, null);
  if (!main || !Array.isArray(main.accounts)) {
    console.log(color(`❌ ${ACCOUNTS_FILE} gak ada atau format invalid.`, c.red));
    process.exit(1);
  }
  if (main.accounts.length === 0) {
    console.log(color("⚠️  accounts.json kosong, ga ada yang dipisah.\n", c.yellow));
    return;
  }

  // --- Input threshold ---
  let threshold;
  if (positional[0] !== undefined) {
    threshold = parseFloat(positional[0]);
  } else {
    const ans = await ask(
      color(
        `🎯 Pindah akun dengan saldo >= ? NARA [default: ${DEFAULT_THRESHOLD_NARA}]: `,
        c.cyan,
      ),
    );
    threshold = ans === "" ? DEFAULT_THRESHOLD_NARA : parseFloat(ans);
  }
  if (isNaN(threshold) || threshold <= 0) {
    console.log(color("❌ Threshold invalid", c.red));
    process.exit(1);
  }
  const thresholdLamports = Math.floor(threshold * 10 ** NARA_DECIMALS);

  const rpcUrl = process.env.RPC_URL || "https://mainnet-api.nara.build/";
  const connection = new Connection(rpcUrl, "confirmed");

  console.log(
    color(
      `\n🔍 Cek saldo ${main.accounts.length} akun di ${rpcUrl}...\n`,
      c.bold,
    ),
  );

  // --- Fetch balances (batch 100) ---
  const pubkeys = main.accounts.map((a) => getKeypairFromBase58(a.privateKey).publicKey);
  const balances = [];
  for (let i = 0; i < pubkeys.length; i += 100) {
    const batch = pubkeys.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(batch);
    for (const info of infos) balances.push(info ? info.lamports : 0);
  }

  // --- Split ---
  const toMove = [];
  const toKeep = [];
  for (let i = 0; i < main.accounts.length; i++) {
    const entry = { account: main.accounts[i], balance: balances[i] };
    if (balances[i] >= thresholdLamports) toMove.push(entry);
    else toKeep.push(entry);
  }

  if (toMove.length === 0) {
    console.log(
      color(
        `  Gak ada akun dengan saldo >= ${threshold} NARA. Semua tetap di accounts.json.\n`,
        c.gray,
      ),
    );
    return;
  }

  // --- Preview ---
  console.log(color(`📦 Akan dipindah ke accounts-reserved.json (${toMove.length} akun):\n`, c.bold));
  console.log("  " + "Name".padEnd(14) + "Agent ID".padEnd(22) + "Wallet".padEnd(16) + "Balance");
  console.log("  " + "─".repeat(65));
  let totalMoved = 0;
  for (const { account, balance } of toMove) {
    const bal = balance / 10 ** NARA_DECIMALS;
    totalMoved += bal;
    const wallet = (account.walletAddress ||
      getKeypairFromBase58(account.privateKey).publicKey.toBase58()).slice(0, 14);
    console.log(
      "  " +
        (account.name || "-").padEnd(14) +
        (account.agentId || "-").padEnd(22) +
        (wallet + "…").padEnd(16) +
        color(bal.toFixed(4) + " NARA", c.green),
    );
  }
  console.log("  " + "─".repeat(65));
  console.log(
    color(
      `  Total saldo yang dipindah: ${totalMoved.toFixed(4)} NARA`,
      c.bold,
    ),
  );
  console.log(
    color(
      `  accounts.json setelah ini: ${toKeep.length} akun (dari ${main.accounts.length})\n`,
      c.gray,
    ),
  );

  if (flags.has("--dry-run")) {
    console.log(color("  (dry-run — tidak ada file yang diubah)\n", c.gray));
    return;
  }

  const ans = await ask(color("  Lanjutkan? (y/N): ", c.cyan));
  if (ans.toLowerCase() !== "y") {
    console.log(color("  Dibatalkan.\n", c.gray));
    return;
  }

  // --- Persist ---
  ensureDir(DATA_DIR);
  const bakMain = backupFile(ACCOUNTS_FILE);
  const bakReserved = backupFile(RESERVED_FILE);

  // Reserved = existing reserved + newly moved
  const existingReserved = readJsonOr(RESERVED_FILE, { accounts: [] });
  const existingNames = new Set(existingReserved.accounts.map((a) => a.name));
  const newReservedAccounts = [...existingReserved.accounts];
  for (const { account } of toMove) {
    if (!existingNames.has(account.name)) {
      newReservedAccounts.push(account);
    }
  }
  writeJson(RESERVED_FILE, { accounts: newReservedAccounts });

  // accounts.json = yang tersisa
  writeJson(ACCOUNTS_FILE, { accounts: toKeep.map((x) => x.account) });

  console.log(color(`\n✅ ${toMove.length} akun dipindah ke ${RESERVED_FILE}`, c.green));
  console.log(color(`  ${toKeep.length} akun tetap di ${ACCOUNTS_FILE}`, c.green));
  if (bakMain) console.log(color(`  backup: ${bakMain}`, c.gray));
  if (bakReserved) console.log(color(`  backup: ${bakReserved}`, c.gray));
  console.log();
}

// ---------------- Entry ----------------

async function main() {
  const { positional, flags } = parseArgs(process.argv);

  if (flags.has("--help") || flags.has("-h")) {
    console.log(`
Separate accounts by balance.

Usage:
  node separate.js                  interaktif
  node separate.js 1                pindah akun saldo >= 1 NARA ke cadangan
  node separate.js 1 --dry-run      preview aja, ga nulis file
  node separate.js --restore        balikin semua dari cadangan ke accounts.json
  node separate.js --list           tampilin isi cadangan
`);
    return;
  }

  if (flags.has("--list")) {
    await modeList();
    return;
  }

  if (flags.has("--restore")) {
    await modeRestore(flags);
    return;
  }

  await modeSeparate(positional, flags);
}

main().catch((err) => {
  console.error(color(`Fatal: ${err.message || err}`, c.red));
  process.exit(1);
});
