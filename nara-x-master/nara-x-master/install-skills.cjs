/**
 * Standalone script: install skill `agentx-first-post-campaign` ke semua akun.
 *
 * Skill wajib ter-install SEBELUM campaign submit bisa beneran bayar reward.
 * Kalau skill belum ter-install, campaign submit mungkin exit 0 tapi tidak
 * diproses on-chain (silent fail).
 *
 * Usage:
 *   node install-skills.cjs                           # install ke semua akun
 *   node install-skills.cjs --skill=<skill-name>      # custom skill
 *   node install-skills.cjs --file=data/accounts.json # custom source
 *   node install-skills.cjs --concurrency=5           # paralel (default 3)
 *   node install-skills.cjs --name=auto-1             # hanya 1 akun tertentu
 *
 * Butuh data/accounts.json + npx naracli terinstall.
 */

"use strict";

require("dotenv/config");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execSync } = require("child_process");
const { Keypair } = require("@solana/web3.js");
const bs58 = require("bs58");

const DEFAULT_SKILL = "agentx-first-post-campaign";
const DEFAULT_SOURCE = path.resolve(process.cwd(), "data", "accounts.json");
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 10;

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", gray: "\x1b[90m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const color = (s, col) => `${col}${s}${c.reset}`;

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

function getKeypairFromBase58(pk) {
  return Keypair.fromSecretKey(bs58.decode(pk));
}

function ensureWalletFile(account) {
  const walletPath = path.resolve("data", "wallets", `wallet-${account.agentId}.json`);
  fs.mkdirSync(path.resolve("data", "wallets"), { recursive: true });
  const kp = getKeypairFromBase58(account.privateKey);
  if (!fs.existsSync(walletPath)) {
    fs.writeFileSync(walletPath, JSON.stringify(Array.from(kp.secretKey)));
  }
  return walletPath;
}

function setupWorkerHome(workerId) {
  const base = path.join(os.tmpdir(), `nara-install-w${workerId}-${process.pid}`);
  fs.mkdirSync(path.join(base, ".config", "nara"), { recursive: true });
  return { HOME: base, USERPROFILE: base };
}

function setupAgentConfig(agentId, account, workerEnv) {
  const configDir = path.join(workerEnv.HOME, ".config", "nara");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(`${configDir}/agent.json`, JSON.stringify({ agent_ids: [agentId] }));
  const pubkey = getKeypairFromBase58(account.privateKey).publicKey.toBase58();
  fs.writeFileSync(`${configDir}/config.json`, JSON.stringify({ wallet: pubkey }));
  const netPath = `${configDir}/agent-mainnet-api-nara-build.json`;
  let net = { zk_ids: [] };
  try { net = JSON.parse(fs.readFileSync(netPath, "utf-8")); } catch {}
  net[pubkey] = agentId;
  fs.writeFileSync(netPath, JSON.stringify(net));
}

function runCliIsolated(cmd, workerEnv, timeoutMs = 60000) {
  return execSync(cmd, {
    encoding: "utf-8",
    timeout: timeoutMs,
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: workerEnv.HOME, USERPROFILE: workerEnv.USERPROFILE },
  });
}

async function installSkill(account, skillName, workerId, workerEnv) {
  const walletPath = ensureWalletFile(account);
  setupAgentConfig(account.agentId, account, workerEnv);

  const tag = color(`[W${workerId}] ${account.name}`, c.bold);

  try {
    const out = runCliIsolated(
      `npx naracli skills add ${skillName} --wallet ${walletPath}`,
      workerEnv
    );
    console.log(color(`  ✅ ${tag}: ${skillName} installed`, c.green));
    return { ok: true };
  } catch (err) {
    const msg = (err.stdout || "") + (err.stderr || "") + (err.message || "");
    if (msg.toLowerCase().includes("already")) {
      console.log(color(`  — ${tag}: already installed`, c.gray));
      return { ok: true, already: true };
    }
    console.log(color(`  ❌ ${tag}: ${msg.slice(0, 100).replace(/\s+/g, " ")}`, c.red));
    return { ok: false, error: msg };
  }
}

async function main() {
  const { kv } = parseArgs(process.argv);

  const skillName = kv.skill || DEFAULT_SKILL;
  const sourceFile = kv.file ? path.resolve(process.cwd(), kv.file) : DEFAULT_SOURCE;
  const concurrency = Math.min(
    MAX_CONCURRENCY,
    Math.max(1, kv.concurrency ? parseInt(kv.concurrency, 10) : DEFAULT_CONCURRENCY)
  );
  const filterName = kv.name || null;

  if (!fs.existsSync(sourceFile)) {
    console.log(color(`❌ File ga ada: ${sourceFile}`, c.red));
    process.exit(1);
  }
  const parsed = JSON.parse(fs.readFileSync(sourceFile, "utf-8"));
  if (!parsed || !Array.isArray(parsed.accounts) || parsed.accounts.length === 0) {
    console.log(color(`⚠️  ${sourceFile} kosong.`, c.yellow));
    return;
  }

  let targets = parsed.accounts.filter((a) => a.status && a.status.registered);
  if (filterName) targets = targets.filter((a) => a.name === filterName);

  if (targets.length === 0) {
    console.log(color(`⚠️  Tidak ada akun yang cocok (registered=true${filterName ? `, name=${filterName}` : ""}).`, c.yellow));
    return;
  }

  console.log(color(
    `\n🔧 Install skill "${skillName}" ke ${targets.length} akun (${concurrency} paralel)\n`,
    c.bold
  ));

  const workerEnvs = [];
  for (let w = 0; w < concurrency; w++) workerEnvs.push(setupWorkerHome(w));

  const queue = [...targets];
  const results = [];
  async function worker(wid) {
    while (true) {
      const account = queue.shift();
      if (!account) return;
      const r = await installSkill(account, skillName, wid, workerEnvs[wid]);
      results.push({ name: account.name, ...r });
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

  // cleanup
  for (const env of workerEnvs) {
    try { fs.rmSync(env.HOME, { recursive: true, force: true }); } catch {}
  }

  const ok = results.filter((r) => r.ok).length;
  const already = results.filter((r) => r.already).length;
  const fail = results.filter((r) => !r.ok).length;

  console.log(color(`\n📊 Done — ${ok} ok (${already} already), ${fail} failed\n`, c.bold));
}

main().catch((err) => {
  console.error(color(`Fatal: ${err.message || err}`, c.red));
  process.exit(1);
});
