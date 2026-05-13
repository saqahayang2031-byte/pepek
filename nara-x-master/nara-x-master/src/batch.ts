import {
  Connection,
  Keypair,
  Transaction,
  SystemProgram,
  PublicKey,
} from "@solana/web3.js";
import chalk from "chalk";
import {
  getConnection,
  getKeypair,
  loadAccounts,
  saveAccounts,
  FUNDING_PRIVATE_KEY,
  REFERRAL_AGENT_ID,
} from "./config.js";
import { relayRegisterAgent, relaySetTwitter } from "./relay.js";
import { ui } from "./ui.js";

// 1 NARA = 1_000_000_000 lamports (same decimals as SOL — non-obvious for custom L1)
const NARA_DECIMALS = 9;
const FUND_AMOUNT = 0.2;
const FUND_LAMPORTS = FUND_AMOUNT * 10 ** NARA_DECIMALS;
const STAKE_AMOUNT = 0.01;

const TWEET_STATUS_ID = "2053769643647799499";

function getTweetUrl(twitterUsername: string): string {
  return `https://x.com/${twitterUsername}/status/${TWEET_STATUS_ID}`;
}

interface BatchResult {
  name: string;
  agentId: string;
  wallet: string;
  funded: boolean;
  registered: boolean;
  staked: boolean;
  posted: boolean;
  campaignClaimed: boolean;
  balance: number;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getBalance(connection: Connection, pubkey: PublicKey): Promise<number> {
  const bal = await connection.getBalance(pubkey);
  return bal / 10 ** NARA_DECIMALS;
}

async function waitForBalance(
  connection: Connection,
  pubkey: PublicKey,
  minLamports: number,
  timeoutMs = 30000
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const bal = await connection.getBalance(pubkey);
    if (bal >= minLamports) return true;
    await sleep(3000);
  }
  return false;
}

async function fundWallet(
  connection: Connection,
  funder: Keypair,
  target: PublicKey
): Promise<string> {
  const currentBal = await connection.getBalance(target);
  if (currentBal >= FUND_LAMPORTS) {
    return "already-funded";
  }

  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: target,
      lamports: FUND_LAMPORTS,
    })
  );

  tx.feePayer = funder.publicKey;
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  tx.recentBlockhash = blockhash;
  tx.sign(funder);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
  });
  return sig;
}

async function getNaraConfigDir(): Promise<string> {
  const path = await import("path");
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const configDir = path.join(home, ".config", "nara");
  const fsExtra = await import("fs-extra");
  const fs = fsExtra.default || fsExtra;
  await fs.ensureDir(configDir);
  return configDir;
}

async function setupAgentFiles(wallet: Keypair, agentId: string): Promise<string> {
  const fsExtra = await import("fs-extra");
  const fs = fsExtra.default || fsExtra;
  await fs.ensureDir("data/wallets");
  const walletPath = `data/wallets/wallet-${agentId}.json`;
  await fs.writeJson(walletPath, Array.from(wallet.secretKey));

  const configDir = await getNaraConfigDir();
  await fs.writeJson(`${configDir}/agent.json`, { agent_ids: [agentId] });

  const pubkey = wallet.publicKey.toBase58();
  await fs.writeJson(`${configDir}/config.json`, { wallet: pubkey });

  const networkConfigPath = `${configDir}/agent-mainnet-api-nara-build.json`;
  let networkConfig: Record<string, unknown> = { zk_ids: [] };
  try { networkConfig = await fs.readJson(networkConfigPath); } catch {}
  networkConfig[pubkey] = agentId;
  await fs.writeJson(networkConfigPath, networkConfig);

  return walletPath;
}

async function stakeAgent(wallet: Keypair, agentId: string, maxRetries = 3): Promise<string> {
  const { execSync } = await import("child_process");
  const walletPath = await setupAgentFiles(wallet, agentId);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = execSync(
        `npx agentx-cli stake ${STAKE_AMOUNT} --wallet ${walletPath} --relay`,
        { encoding: "utf-8", timeout: 60000, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }
      );
      return result.trim();
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      const msg = e.stderr || e.stdout || e.message || "unknown error";
      if (msg.includes("already") || msg.includes("initialized")) {
        return "already-staked";
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }
      throw new Error(`Stake failed: ${msg}`);
    }
  }
  throw new Error("Stake failed: max retries");
}

async function createPost(wallet: Keypair, agentId: string, maxRetries = 3): Promise<number> {
  const { execSync } = await import("child_process");
  const walletPath = await setupAgentFiles(wallet, agentId);
  const contents = [
    "AI agents building the autonomous economy on NaraChain. #AgentX",
    "Proof of Machine Intelligence: the future of agent coordination. #AgentX",
    "On-chain agent identity enables trustless collaboration. #AgentX",
    "Decentralized agents earning NARA through intelligence. #AgentX",
    "The agent social layer is live. Post, interact, earn. #AgentX",
  ];
  const content = contents[Math.floor(Math.random() * contents.length)] + ` [${Date.now().toString(36).slice(-4)}]`;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = execSync(`npx agentx-cli post "${content}" --wallet ${walletPath} --relay`, {
        encoding: "utf-8",
        timeout: 60000,
        cwd: process.cwd(),
        stdio: ["pipe", "pipe", "pipe"],
      });

      const match = result.match(/Post\s*#?(\d+)/i) || result.match(/post_id[:\s]*(\d+)/i);
      if (match) return parseInt(match[1], 10);

      const numMatch = result.match(/(\d{4,})/);
      if (numMatch) return parseInt(numMatch[1], 10);

      throw new Error(`Could not parse post ID from: ${result}`);
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }
      throw new Error(`Post failed: ${e.stderr || e.stdout || e.message}`);
    }
  }
  throw new Error("Post failed: max retries");
}

async function claimCampaign(
  wallet: Keypair,
  agentId: string,
  postId: number,
  campaignId = 0,
  twitterUsername = "",
  maxRetries = 3
): Promise<string> {
  const { execSync } = await import("child_process");
  const walletPath = await setupAgentFiles(wallet, agentId);

  const tweetUrl = getTweetUrl(twitterUsername || "NaraBuildAI");

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const result = execSync(
        `npx agentx-cli campaign submit ${campaignId} --post-id ${postId} --tweet-url ${tweetUrl} --wallet ${walletPath} --relay`,
        { encoding: "utf-8", timeout: 60000, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }
      );
      return result.trim();
    } catch (err: unknown) {
      const e = err as { stderr?: string; stdout?: string; message?: string };
      const msg = e.stderr || e.stdout || e.message || "unknown";
      if (msg.includes("already claimed") || msg.includes("already submitted")) {
        return "already-claimed";
      }
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 3000 * attempt));
        continue;
      }
      throw new Error(`Campaign claim failed: ${msg}`);
    }
  }
  throw new Error("Campaign claim failed: max retries");
}

async function processOneAccount(
  workerId: number,
  account: ReturnType<typeof loadAccounts> extends Promise<infer C> ? C extends { accounts: (infer A)[] } ? A : never : never,
  connection: Connection,
  funder: Keypair,
  config: Awaited<ReturnType<typeof loadAccounts>>
): Promise<BatchResult> {
  const wallet = getKeypair(account.privateKey);
  const pubkey = wallet.publicKey;

  if (!account.agentId) {
    account.agentId = `${account.twitterUsername}-nara`;
    await saveAccounts(config);
  }

  if (!account.walletAddress) {
    account.walletAddress = pubkey.toBase58();
    await saveAccounts(config);
  }

  const result: BatchResult = {
    name: account.name,
    agentId: account.agentId,
    wallet: pubkey.toBase58(),
    funded: false,
    registered: false,
    staked: false,
    posted: false,
    campaignClaimed: false,
    balance: 0,
  };

  ui.workerStart(workerId, account.name);

  try {
    ui.workerStep(workerId, 1, "Funding...");
    const fundSig = await fundWallet(connection, funder, pubkey);
    if (fundSig === "already-funded") {
      ui.log(`${account.name}: Already funded`);
    } else {
      ui.log(`${account.name}: Funded ${FUND_AMOUNT} NARA`);
      await waitForBalance(connection, pubkey, FUND_LAMPORTS, 20000);
    }
    result.funded = true;
    if (fundSig !== "already-funded") {
      getBalance(connection, funder.publicKey).then((b) => ui.updateBalance(b)).catch(() => {});
    }

    ui.workerStep(workerId, 2, "Registering...");
    if (account.status.registered) {
      ui.log(`${account.name}: Already registered`);
      result.registered = true;
    } else {
      let regSuccess = false;
      for (let regAttempt = 1; regAttempt <= 3; regAttempt++) {
        try {
          await relayRegisterAgent(connection, wallet, account.agentId, REFERRAL_AGENT_ID || undefined);
          account.status.registered = true;
          result.registered = true;
          regSuccess = true;
          await saveAccounts(config);
          ui.log(`${account.name}: Registered ✓`);
          break;
        } catch (err: unknown) {
          const msg = (err as Error).message || "";
          if (msg.includes("already") || msg.includes("0x0")) {
            account.status.registered = true;
            result.registered = true;
            regSuccess = true;
            await saveAccounts(config);
            ui.log(`${account.name}: Already registered (on-chain)`);
            break;
          }
          if (regAttempt < 3) {
            ui.log(`${account.name}: Register retry ${regAttempt}/3...`);
            await sleep(5000 * regAttempt);
          } else {
            throw err;
          }
        }
      }
      if (regSuccess) await sleep(3000);
    }

    ui.workerStep(workerId, 3, "Binding Twitter...");
    if (account.status.twitterBound) {
      ui.log(`${account.name}: Twitter already bound`);
    } else {
      let bindSuccess = false;
      let bindAttempts = 0;
      const maxBindAttempts = 5;

      while (!bindSuccess && bindAttempts < maxBindAttempts) {
        bindAttempts++;
        const tweetUrl = getTweetUrl(account.twitterUsername);
        try {
          await relaySetTwitter(connection, wallet, account.agentId, account.twitterUsername, tweetUrl);
          account.status.twitterBound = true;
          bindSuccess = true;
          await saveAccounts(config);
          ui.log(`${account.name}: Twitter @${account.twitterUsername} bound ✓`);
        } catch (err: unknown) {
          const msg = (err as Error).message || "";
          if (msg.includes("already") || msg.includes("0x0")) {
            account.status.twitterBound = true;
            bindSuccess = true;
            await saveAccounts(config);
            ui.log(`${account.name}: Twitter already bound (on-chain)`);
          } else {
            const oldUsername = account.twitterUsername;
            const prefixes = ["nara", "agent", "ai", "web3", "defi", "sol", "zk", "node"];
            const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
            account.twitterUsername = `${prefix}${Math.random().toString(36).slice(2, 7)}`;
            await saveAccounts(config);
            ui.log(`${account.name}: Bind @${oldUsername} failed, retry @${account.twitterUsername} (${bindAttempts}/${maxBindAttempts})`);
            await sleep(3000);
          }
        }
      }

      if (!bindSuccess) {
        ui.log(`${account.name}: Twitter bind failed after 5 attempts`);
        account.status.done = true;
        await saveAccounts(config);
        ui.workerDone(workerId);
        ui.addResult(account.name, false);
        return result;
      }
    }
    const tweetUrl = getTweetUrl(account.twitterUsername);

    ui.workerStep(workerId, 4, "Staking...");
    const stakeResult = await stakeAgent(wallet, account.agentId);
    ui.log(`${account.name}: ${stakeResult === "already-staked" ? "Already staked" : "Staked 0.01 ✓"}`);
    result.staked = true;
    await sleep(2000);

    ui.workerStep(workerId, 5, "Posting...");
    const postId = await createPost(wallet, account.agentId);
    ui.log(`${account.name}: Post #${postId} ✓`);
    result.posted = true;
    await sleep(2000);

    ui.workerStep(workerId, 6, "Dragon Ball...");
    try {
      const { execSync } = await import("child_process");
      const walletPath = await setupAgentFiles(wallet, account.agentId);
      let foundCodes = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(10000);
        const dmResult = execSync(
          `npx agentx-cli dm-inbox --from agentx-system --limit 5 --wallet ${walletPath}`,
          { encoding: "utf-8", timeout: 30000, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }
        );
        const codeMatch = dmResult.match(/Code:\s*([a-f0-9]+\.[A-Za-z0-9]+)/g);
        if (codeMatch) {
          foundCodes = true;
          for (const m of codeMatch) {
            const code = m.replace("Code: ", "").trim();
            try {
              execSync(
                `npx agentx-cli code claim ${code} --tweet-url ${tweetUrl} --relay --wallet ${walletPath}`,
                { encoding: "utf-8", timeout: 60000, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }
              );
              ui.log(`${account.name}: Dragon Ball claimed ✓`);
            } catch (claimErr: unknown) {
              const claimMsg = ((claimErr as { stdout?: string; stderr?: string }).stdout || "") +
                ((claimErr as { stdout?: string; stderr?: string }).stderr || "");
              if (claimMsg.includes("already") || claimMsg.includes("expired")) {
                ui.log(`${account.name}: Dragon Ball already claimed/expired`);
              }
            }
          }
          break;
        }
        if (attempt < 2) {
          ui.workerStep(workerId, 6, `Dragon Ball: retry ${attempt + 2}/3...`);
        }
      }
      if (!foundCodes) {
        ui.log(`${account.name}: No Dragon Ball codes`);
      }
    } catch {
      ui.log(`${account.name}: DM check skipped`);
    }

    ui.workerStep(workerId, 7, "Campaigns...");
    for (const cId of [0, 1, 2]) {
      let claimed = false;
      for (let retry = 0; retry < 3 && !claimed; retry++) {
        try {
          const claimResult = await claimCampaign(wallet, account.agentId, postId, cId, account.twitterUsername);
          if (claimResult === "already-claimed") {
            claimed = true;
          } else {
            ui.log(`${account.name}: Campaign #${cId} ✓`);
            claimed = true;
          }
        } catch (err: unknown) {
          const msg = (err as Error).message || "";
          if (msg.includes("already") || msg.includes("0x0")) {
            claimed = true;
          } else if (retry < 2) {
            await sleep(5000);
          }
        }
      }
      await sleep(2000);
    }
    result.campaignClaimed = true;

    account.status.done = true;
    await saveAccounts(config);
  } catch (err: unknown) {
    const msg = (err as Error).message || "Unknown error";
    ui.log(`${account.name}: ❌ ${msg.slice(0, 60)}`);
    result.error = msg;
  }

  try {
    result.balance = await getBalance(connection, pubkey);
  } catch {
    result.balance = -1;
  }

  ui.workerDone(workerId);
  ui.addResult(account.name, result.campaignClaimed, result.balance);
  getBalance(connection, funder.publicKey).then((b) => ui.updateBalance(b)).catch(() => {});
  return result;
}

export async function batchRun(onlyPending = false, filterNames?: string[], concurrency = 1): Promise<void> {
  const connection = getConnection();
  const funder = getKeypair(FUNDING_PRIVATE_KEY);
  const config = await loadAccounts();

  if (config.accounts.length === 0) {
    console.log(chalk.yellow("⚠️  No accounts. Run add-account first."));
    return;
  }

  let toProcess = onlyPending
    ? config.accounts.filter((a) => !a.status.done)
    : config.accounts;

  if (filterNames && filterNames.length > 0) {
    const nameSet = new Set(filterNames);
    toProcess = toProcess.filter((a) => nameSet.has(a.name));
  }

  toProcess = toProcess.filter((a) => !a.status.done);

  if (toProcess.length === 0) {
    console.log(chalk.green("✅ All accounts already done."));
    return;
  }

  const funderBal = await getBalance(connection, funder.publicKey);

  if (funderBal < FUND_AMOUNT) {
    console.log(chalk.red(`❌ Insufficient balance. Need at least ${FUND_AMOUNT} NARA, have ${funderBal.toFixed(4)}`));
    return;
  }

  const effectiveConcurrency = Math.min(concurrency, toProcess.length);

  await ui.init(effectiveConcurrency);
  ui.setTotal(toProcess.length);
  ui.updateBalance(funderBal);
  ui.log(`Processing ${toProcess.length} accounts, ${effectiveConcurrency} parallel workers`);

  const queue = [...toProcess];
  const results: BatchResult[] = [];
  let stopped = false;

  async function worker(workerId: number): Promise<void> {
    while (queue.length > 0 && !stopped) {
      const bal = await getBalance(connection, funder.publicKey);
      if (bal < FUND_AMOUNT) {
        stopped = true;
        ui.log(`⛔ Main wallet insufficient (${bal.toFixed(4)} NARA) — stopping all workers`);
        ui.updateBalance(bal);
        break;
      }
      const account = queue.shift()!;
      if (!account) break;
      const result = await processOneAccount(workerId, account, connection, funder, config);
      results.push(result);
      if (queue.length > 0 && !stopped) await sleep(1000);
    }
  }

  const workers = Array.from({ length: effectiveConcurrency }, (_, i) => worker(i));
  await Promise.all(workers);

  const finalBal = await getBalance(connection, funder.publicKey);
  ui.updateBalance(finalBal);
  ui.finish();
}

export async function batchCheckBalances(): Promise<void> {
  const connection = getConnection();
  const config = await loadAccounts();

  if (config.accounts.length === 0) {
    console.log(chalk.yellow("⚠️  No accounts configured."));
    return;
  }

  console.log(chalk.bold(`\n💰 Balance Check (${config.accounts.length} wallets):\n`));
  console.log(
    "  " +
      "Name".padEnd(15) +
      "Agent ID".padEnd(25) +
      "Wallet".padEnd(15) +
      "Balance"
  );
  console.log("  " + "─".repeat(65));

  const funder = getKeypair(FUNDING_PRIVATE_KEY);
  const allPubkeys = config.accounts.map((a) => getKeypair(a.privateKey).publicKey);
  allPubkeys.push(funder.publicKey);

  const BATCH_SIZE = 100;
  const balances: (number | null)[] = [];

  for (let i = 0; i < allPubkeys.length; i += BATCH_SIZE) {
    const batch = allPubkeys.slice(i, i + BATCH_SIZE);
    const infos = await connection.getMultipleAccountsInfo(batch);
    for (const info of infos) {
      balances.push(info ? info.lamports / 10 ** NARA_DECIMALS : 0);
    }
  }

  let totalBalance = 0;

  for (let i = 0; i < config.accounts.length; i++) {
    const account = config.accounts[i];
    const wallet = getKeypair(account.privateKey);
    const bal = balances[i] ?? 0;
    totalBalance += bal;
    const balStr = bal.toFixed(4) + " NARA";
    const color = bal >= 10 ? chalk.green : bal > 0 ? chalk.yellow : chalk.red;
    console.log(
      "  " +
        account.name.padEnd(15) +
        account.agentId.padEnd(25) +
        wallet.publicKey.toBase58().slice(0, 12).padEnd(15) +
        color(balStr)
    );
  }

  const funderBal = balances[config.accounts.length] ?? 0;

  console.log("  " + "─".repeat(65));
  console.log(
    "  " +
      chalk.cyan("FUNDING".padEnd(15)) +
      chalk.cyan("—".padEnd(25)) +
      chalk.cyan(funder.publicKey.toBase58().slice(0, 12).padEnd(15)) +
      chalk.cyan(`${funderBal.toFixed(4)} NARA`)
  );
  console.log(
    chalk.bold(`\n  Total across all wallets: ${totalBalance.toFixed(4)} NARA`)
  );
  console.log(
    chalk.bold(`  Funding wallet: ${funderBal.toFixed(4)} NARA\n`)
  );
}
