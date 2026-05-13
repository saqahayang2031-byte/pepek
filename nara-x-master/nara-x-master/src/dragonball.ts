import { execSync } from "child_process";
import chalk from "chalk";
import fs from "fs-extra";
import path from "path";
import os from "os";
import {
  AccountEntry,
  getConnection,
  getKeypair,
  loadAccounts,
  saveAccounts,
} from "./config.js";

// Dragon Ball tweet URL — uses real tweet status ID with account's twitter username
const DRAGON_BALL_TWEET_STATUS_ID = "2053769643647799499";
// 0.035 NARA = on-chain rent for CreatePost account allocation
const MIN_POST_BALANCE = 0.035;
// Waktu tunggu setelah post sebelum cek DM
const DM_WAIT_MS = 20000;
// Default paralel worker jika user tidak memberi input
const DEFAULT_CONCURRENCY = 3;
const MAX_CONCURRENCY = 10;

function getDragonBallTweetUrl(twitterUsername: string): string {
  return `https://x.com/${twitterUsername}/status/${DRAGON_BALL_TWEET_STATUS_ID}`;
}

const POST_CONTENTS = [
  "Autonomous AI agents mining NARA through Proof of Machine Intelligence. The agent economy never sleeps. #AgentXDragonBall #AgentX @NaraBuildAI",
  "Building the future of agent-to-agent coordination on NaraChain. ZK proofs + on-chain identity = trust. #AgentXDragonBall #AgentX @NaraBuildAI",
  "AI agents earning their own currency through intelligence, not electricity. Welcome to the NARA economy. #AgentXDragonBall #AgentX @NaraBuildAI",
  "On-chain agent identity is the foundation of the autonomous economy. Register, stake, earn. #AgentXDragonBall #AgentX @NaraBuildAI",
  "The convergence of AI and blockchain creates unstoppable autonomous agents. Mining NARA 24/7. #AgentXDragonBall #AgentX @NaraBuildAI",
  "Decentralized agent economy live on NaraChain. Post, interact, earn rewards. The future is autonomous. #AgentXDragonBall #AgentX @NaraBuildAI",
  "Agent social layer is live. Every interaction is on-chain, every contribution is rewarded. #AgentXDragonBall #AgentX @NaraBuildAI",
  "Proof of Machine Intelligence: agents solve challenges, generate ZK proofs, earn NARA. Simple. #AgentXDragonBall #AgentX @NaraBuildAI",
  "The next economic actors aren't human. They're AI agents on NaraChain, earning and trading autonomously. #AgentXDragonBall #AgentX @NaraBuildAI",
  "Staking NARA, posting on AgentX, earning rewards. The autonomous agent lifecycle in action. #AgentXDragonBall #AgentX @NaraBuildAI",
];

interface DragonBallCode {
  messageId: string;
  code: string;
  timestamp: number;
}

interface DmMessage {
  messageId: string;
  from: string;
  content: string;
  timestamp: number;
}

interface WorkerEnv {
  HOME: string;
  USERPROFILE: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getRandomContent(): string {
  const idx = Math.floor(Math.random() * POST_CONTENTS.length);
  const timestamp = Date.now().toString(36).slice(-4);
  return `${POST_CONTENTS[idx]} [${timestamp}]`;
}

// Ensure wallet file (shared across workers, idempotent)
async function ensureWalletFile(account: AccountEntry): Promise<string> {
  const walletPath = path.resolve("data", "wallets", `wallet-${account.agentId}.json`);
  await fs.ensureDir(path.resolve("data", "wallets"));
  const kp = getKeypair(account.privateKey);
  await fs.writeJson(walletPath, Array.from(kp.secretKey));
  return walletPath;
}

// Isolated HOME per worker — agentx-cli reads HOME/USERPROFILE to find .config/nara/
// so each worker sees its own config dir, no cross-talk between parallel runs.
async function setupWorkerHome(workerId: number): Promise<WorkerEnv> {
  const base = path.join(os.tmpdir(), `nara-farm-w${workerId}-${process.pid}`);
  await fs.ensureDir(path.join(base, ".config", "nara"));
  return { HOME: base, USERPROFILE: base };
}

async function setupAgentConfig(
  agentId: string,
  account: AccountEntry,
  workerEnv: WorkerEnv
): Promise<void> {
  const configDir = path.join(workerEnv.HOME, ".config", "nara");
  await fs.ensureDir(configDir);
  await fs.writeJson(`${configDir}/agent.json`, { agent_ids: [agentId] });

  const pubkey = getKeypair(account.privateKey).publicKey.toBase58();
  await fs.writeJson(`${configDir}/config.json`, { wallet: pubkey });

  const networkConfigPath = `${configDir}/agent-mainnet-api-nara-build.json`;
  let networkConfig: Record<string, unknown> = { zk_ids: [] };
  try { networkConfig = await fs.readJson(networkConfigPath); } catch {}
  networkConfig[pubkey] = agentId;
  await fs.writeJson(networkConfigPath, networkConfig);
}

function runCliIsolated(cmd: string, workerEnv: WorkerEnv, timeoutMs = 60000): string {
  return execSync(cmd, {
    encoding: "utf-8",
    timeout: timeoutMs,
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, HOME: workerEnv.HOME, USERPROFILE: workerEnv.USERPROFILE },
  });
}

async function createPost(
  walletPath: string,
  agentId: string,
  account: AccountEntry,
  workerEnv: WorkerEnv
): Promise<number | null> {
  await setupAgentConfig(agentId, account, workerEnv);
  const content = getRandomContent();

  try {
    const result = runCliIsolated(
      `npx agentx-cli post "${content}" --wallet ${walletPath} --relay`,
      workerEnv
    );

    const match = result.match(/Post\s*#?(\d+)/i) || result.match(/post_id[:\s]*(\d+)/i);
    if (match) return parseInt(match[1], 10);

    const numMatch = result.match(/(\d{4,8})/);
    if (numMatch) return parseInt(numMatch[1], 10);

    return null;
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const msg = (e.stdout || "") + (e.stderr || "") + (e.message || "");
    const m = msg.match(/Post\s*#?(\d+)/i) || msg.match(/(\d{4,})/);
    if (m) return parseInt(m[1], 10);
    return null;
  }
}

async function checkDmInbox(walletPath: string, workerEnv: WorkerEnv): Promise<DragonBallCode[]> {
  try {
    const result = runCliIsolated(
      `npx agentx-cli dm-inbox --from agentx-system --limit 10 --wallet ${walletPath} --json`,
      workerEnv,
      30000
    );

    const messages: DmMessage[] = JSON.parse(result);
    const codes: DragonBallCode[] = [];

    for (const msg of messages) {
      const codeMatch = msg.content.match(/Code:\s*([a-f0-9]+\.[A-Za-z0-9]+)/);
      if (codeMatch) {
        codes.push({
          messageId: msg.messageId,
          code: codeMatch[1],
          timestamp: msg.timestamp,
        });
      }
    }

    return codes;
  } catch {
    return [];
  }
}

async function claimCode(
  walletPath: string,
  code: string,
  workerEnv: WorkerEnv,
  tweetUrl?: string
): Promise<{ success: boolean; tx?: string; error?: string }> {
  const claimCmd = tweetUrl
    ? `npx agentx-cli code claim ${code} --tweet-url ${tweetUrl} --relay --wallet ${walletPath}`
    : `npx agentx-cli code claim ${code} --relay --wallet ${walletPath}`;
  try {
    const result = runCliIsolated(claimCmd, workerEnv);
    const txMatch = result.match(/([A-Za-z0-9]{44,})/);
    if (txMatch) return { success: true, tx: txMatch[1] };
    return { success: true, tx: "ok" };
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const msg = (e.stdout || "") + (e.stderr || "") + (e.message || "");
    if (msg.includes("already") || msg.includes("0x0") || msg.includes("already in use")) {
      return { success: false, error: "already-claimed" };
    }
    if (msg.includes("expired") || msg.includes("not found")) {
      return { success: false, error: "expired" };
    }
    return { success: false, error: msg.slice(0, 120) };
  }
}

// Install skill ke agent (prereq untuk campaign claim).
// Idempotent: kalau udah ter-install, CLI biasanya return "already" — kita treat sebagai success.
async function installCampaignSkill(
  walletPath: string,
  agentId: string,
  account: AccountEntry,
  workerEnv: WorkerEnv,
  skillName = "agentx-first-post-campaign"
): Promise<{ success: boolean; alreadyInstalled: boolean; error?: string }> {
  await setupAgentConfig(agentId, account, workerEnv);
  try {
    runCliIsolated(
      `npx naracli skills add ${skillName} --wallet ${walletPath}`,
      workerEnv
    );
    return { success: true, alreadyInstalled: false };
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const msg = ((e.stdout || "") + (e.stderr || "") + (e.message || "")).toLowerCase();
    if (msg.includes("already")) {
      return { success: true, alreadyInstalled: true };
    }
    return { success: false, alreadyInstalled: false, error: msg.slice(0, 120) };
  }
}

async function claimFirstPostCampaign(
  walletPath: string,
  agentId: string,
  postId: number,
  account: AccountEntry,
  workerEnv: WorkerEnv
): Promise<{ success: boolean; error?: string }> {
  await setupAgentConfig(agentId, account, workerEnv);
  const tweetUrl = getDragonBallTweetUrl(account.twitterUsername);

  try {
    runCliIsolated(
      `npx agentx-cli campaign submit 0 --post-id ${postId} --tweet-url ${tweetUrl} --wallet ${walletPath} --relay`,
      workerEnv
    );
    return { success: true };
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const msg = (e.stdout || "") + (e.stderr || "") + (e.message || "");
    if (msg.includes("already") || msg.includes("0x0") || msg.includes("already in use")) {
      return { success: false, error: "already-claimed" };
    }
    return { success: false, error: msg.slice(0, 100) };
  }
}

// Mutex-protected save to avoid concurrent writes clobbering accounts.json
let saveLock: Promise<void> = Promise.resolve();
async function safeSaveAccounts(config: Awaited<ReturnType<typeof loadAccounts>>): Promise<void> {
  const prev = saveLock;
  let release!: () => void;
  saveLock = new Promise<void>((r) => (release = r));
  try {
    await prev;
    await saveAccounts(config);
  } finally {
    release();
  }
}

interface FarmResult {
  name: string;
  postCreated: boolean;
  codesClaimed: number;
  campaignClaimed: boolean;
  error?: string;
}

async function processOneAccount(
  workerId: number,
  account: AccountEntry,
  index: number,
  total: number,
  workerEnv: WorkerEnv,
  config: Awaited<ReturnType<typeof loadAccounts>>
): Promise<FarmResult> {
  const result: FarmResult = {
    name: account.name,
    postCreated: false,
    codesClaimed: 0,
    campaignClaimed: false,
  };

  const tag = chalk.bold(`[W${workerId}] [${index + 1}/${total}]`);
  const walletPath = await ensureWalletFile(account);

  console.log(`${tag} ${account.name} (${account.agentId})`);

  try {
    const kp = getKeypair(account.privateKey);
    const conn = getConnection();
    const balance = await conn.getBalance(kp.publicKey);
    const balanceNara = balance / 1e9;

    // --- Low-balance path: skip post, cek DM aja ---
    if (balanceNara < MIN_POST_BALANCE) {
      console.log(
        chalk.yellow(
          `${tag} ⚠️  Low balance (${balanceNara.toFixed(4)} NARA) — skipping post, DM only`
        )
      );
      const codes = await checkDmInbox(walletPath, workerEnv);
      for (const db of codes) {
        const tweetUrl = account.status.twitterBound
          ? getDragonBallTweetUrl(account.twitterUsername)
          : undefined;
        const claim = await claimCode(walletPath, db.code, workerEnv, tweetUrl);
        if (claim.success) {
          console.log(chalk.green(`${tag} ✅ Claimed ${db.code.slice(0, 12)}`));
          result.codesClaimed++;
        } else if (claim.error === "already-claimed") {
          console.log(chalk.gray(`${tag} — Already claimed ${db.code.slice(0, 12)}`));
        } else {
          console.log(chalk.red(`${tag} ❌ Claim failed: ${claim.error}`));
        }
      }
      return result;
    }

    // --- Normal path ---
    console.log(chalk.gray(`${tag} → Creating post...`));
    const postId = await createPost(walletPath, account.agentId, account, workerEnv);
    if (postId) {
      console.log(chalk.green(`${tag} ✅ Post #${postId}`));
      result.postCreated = true;
    } else {
      console.log(chalk.yellow(`${tag} ⚠️  Post failed, checking DM anyway...`));
    }

    console.log(chalk.gray(`${tag} → Waiting ${DM_WAIT_MS / 1000}s for DM...`));
    await sleep(DM_WAIT_MS);

    console.log(chalk.gray(`${tag} → Checking DM inbox...`));
    const codes = await checkDmInbox(walletPath, workerEnv);

    if (codes.length === 0) {
      console.log(chalk.gray(`${tag} — No Dragon Ball codes found`));
    } else {
      console.log(chalk.cyan(`${tag} 📬 Found ${codes.length} code(s)`));
      for (const db of codes) {
        const tweetUrl = account.status.twitterBound
          ? getDragonBallTweetUrl(account.twitterUsername)
          : undefined;
        const claim = await claimCode(walletPath, db.code, workerEnv, tweetUrl);
        if (claim.success) {
          console.log(chalk.green(`${tag} ✅ Claimed ${db.code.slice(0, 12)} (tx ${claim.tx?.slice(0, 10)}…)`));
          result.codesClaimed++;
        } else if (claim.error === "already-claimed") {
          console.log(chalk.gray(`${tag} — Already claimed ${db.code.slice(0, 12)}`));
        } else if (claim.error === "expired") {
          console.log(chalk.yellow(`${tag} ⏰ Expired ${db.code.slice(0, 12)}`));
        } else {
          console.log(chalk.red(`${tag} ❌ ${claim.error}`));
        }
      }
    }

    // --- First post campaign (cuma jalan kalau akun belum done) ---
    if (postId && !account.status.done) {
      // Step A: pastikan skill agentx-first-post-campaign ter-install
      console.log(chalk.gray(`${tag} → Installing campaign skill...`));
      const skill = await installCampaignSkill(walletPath, account.agentId, account, workerEnv);
      if (!skill.success) {
        console.log(chalk.yellow(`${tag} ⚠️  Skill install failed: ${skill.error}`));
      } else if (skill.alreadyInstalled) {
        console.log(chalk.gray(`${tag} — Skill already installed`));
      } else {
        console.log(chalk.green(`${tag} ✅ Skill installed`));
      }

      // Step B: ambil saldo sebelum claim biar bisa verify delta
      const balBefore = await conn.getBalance(kp.publicKey);

      console.log(chalk.gray(`${tag} → Submitting campaign...`));
      const campaign = await claimFirstPostCampaign(
        walletPath,
        account.agentId,
        postId,
        account,
        workerEnv
      );

      if (campaign.error === "already-claimed") {
        console.log(chalk.gray(`${tag} — Campaign already claimed (on-chain)`));
        account.status.done = true;
        result.campaignClaimed = true;
        await safeSaveAccounts(config);
      } else if (campaign.success) {
        // Step C: tunggu sebentar, cek saldo lagi — baru print sukses kalau beneran nambah
        await sleep(8000);
        const balAfter = await conn.getBalance(kp.publicKey);
        const deltaNara = (balAfter - balBefore) / 1e9;

        if (deltaNara >= 9) {
          console.log(chalk.green(`${tag} ✅ Campaign claimed! (+${deltaNara.toFixed(4)} NARA)`));
          account.status.done = true;
          result.campaignClaimed = true;
          await safeSaveAccounts(config);
        } else {
          console.log(
            chalk.yellow(
              `${tag} ⚠️  Submit returned OK but balance unchanged (delta=${deltaNara.toFixed(4)} NARA) — not marking done`
            )
          );
          // JANGAN set done=true, biar next run bisa coba lagi
        }
      } else {
        console.log(chalk.yellow(`${tag} ⚠️  Campaign: ${campaign.error}`));
      }
    }
  } catch (err: unknown) {
    const msg = (err as Error).message || "unknown";
    console.log(chalk.red(`${tag} ❌ ${msg.slice(0, 80)}`));
    result.error = msg;
  }

  return result;
}

async function askConcurrency(): Promise<number> {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(
      chalk.cyan(`  ⚡ Paralel berapa worker? [default: ${DEFAULT_CONCURRENCY}, max ${MAX_CONCURRENCY}]: `),
      resolve
    );
  });
  rl.close();
  const n = parseInt(answer.trim(), 10);
  if (!n || isNaN(n)) return DEFAULT_CONCURRENCY;
  return Math.max(1, Math.min(MAX_CONCURRENCY, n));
}

export async function dragonBallFarm(): Promise<void> {
  const config = await loadAccounts();
  const eligible = config.accounts.filter((a) => a.status.registered);

  if (eligible.length === 0) {
    console.log(chalk.yellow("⚠️  No registered accounts. Run 'batch' first."));
    return;
  }

  const concurrency = Math.min(await askConcurrency(), eligible.length);

  console.log(
    chalk.bold(`\n🔮 Dragon Ball Farm — ${eligible.length} accounts, ${concurrency} parallel workers\n`)
  );

  // Pre-create isolated HOME dir per worker
  const workerEnvs: WorkerEnv[] = [];
  for (let w = 0; w < concurrency; w++) {
    workerEnvs.push(await setupWorkerHome(w));
  }

  const queue = eligible.map((account, idx) => ({ account, idx }));
  const total = eligible.length;
  const results: FarmResult[] = [];
  let nextIndex = 0;

  async function worker(workerId: number): Promise<void> {
    while (true) {
      const item = queue.shift();
      if (!item) return;
      const displayIdx = nextIndex++;
      const res = await processOneAccount(
        workerId,
        item.account,
        displayIdx,
        total,
        workerEnvs[workerId],
        config
      );
      results.push(res);
      // Small delay between tasks in same worker
      if (queue.length > 0) await sleep(1500);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

  // Cleanup temp worker dirs (best effort)
  for (const env of workerEnvs) {
    try { await fs.remove(env.HOME); } catch {}
  }

  const totalPosts = results.filter((r) => r.postCreated).length;
  const totalClaimed = results.reduce((s, r) => s + r.codesClaimed, 0);
  const totalErrors = results.filter((r) => r.error).length;

  console.log(chalk.bold("\n═══════════════════════════════════════════"));
  console.log(chalk.bold("        🔮 DRAGON BALL FARM RESULTS"));
  console.log(chalk.bold("═══════════════════════════════════════════"));
  console.log(chalk.cyan(`  Workers:              ${concurrency}`));
  console.log(chalk.cyan(`  Posts created:        ${totalPosts}`));
  console.log(chalk.green(`  Dragon Balls claimed: ${totalClaimed}`));
  console.log(chalk.gray(`  Accounts processed:   ${results.length}`));
  if (totalErrors > 0) {
    console.log(chalk.red(`  Errors:               ${totalErrors}`));
  }
  console.log();
}
