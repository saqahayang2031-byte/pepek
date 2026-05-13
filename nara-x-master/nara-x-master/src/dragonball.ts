import { execSync } from "child_process";
import chalk from "chalk";
import fs from "fs-extra";
import path from "path";
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function getRandomContent(): string {
  const idx = Math.floor(Math.random() * POST_CONTENTS.length);
  const timestamp = Date.now().toString(36).slice(-4);
  return `${POST_CONTENTS[idx]} [${timestamp}]`;
}

async function ensureWalletFile(account: AccountEntry): Promise<string> {
  const walletPath = path.resolve("data", "wallets", `wallet-${account.agentId}.json`);
  await fs.ensureDir(path.resolve("data", "wallets"));
  const kp = getKeypair(account.privateKey);
  await fs.writeJson(walletPath, Array.from(kp.secretKey));
  return walletPath;
}

async function setupAgentConfig(agentId: string, account: AccountEntry): Promise<void> {
  const home = process.env.HOME || process.env.USERPROFILE || "";
  const configDir = path.join(home, ".config", "nara");
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

async function createPost(walletPath: string, agentId: string, account: AccountEntry): Promise<number | null> {
  await setupAgentConfig(agentId, account);
  const content = getRandomContent();

  try {
    const result = execSync(
      `npx agentx-cli post "${content}" --wallet ${walletPath} --relay`,
      { encoding: "utf-8", timeout: 60000, cwd: process.cwd() }
    );

    const allOutput = result;
    const match = allOutput.match(/Post\s*#?(\d+)/i) || allOutput.match(/post_id[:\s]*(\d+)/i);
    if (match) return parseInt(match[1], 10);

    const numMatch = allOutput.match(/(\d{4,8})/);
    if (numMatch) return parseInt(numMatch[1], 10);

    return null;
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const msg = (e.stdout || "") + (e.stderr || "") + (e.message || "");
    const m = msg.match(/Post\s*#?(\d+)/i) || msg.match(/(\d{4,})/);
    if (m) return parseInt(m[1], 10);
    console.log(chalk.red(`    Post error: ${msg.slice(0, 100)}`));
    return null;
  }
}

async function checkDmInbox(walletPath: string): Promise<DragonBallCode[]> {
  try {
    const result = execSync(
      `npx agentx-cli dm-inbox --from agentx-system --limit 10 --wallet ${walletPath} --json`,
      { encoding: "utf-8", timeout: 30000, cwd: process.cwd() }
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

async function claimCode(walletPath: string, code: string, tweetUrl?: string): Promise<{ success: boolean; tx?: string; error?: string }> {
  const claimCmd = tweetUrl
    ? `npx agentx-cli code claim ${code} --tweet-url ${tweetUrl} --relay --wallet ${walletPath}`
    : `npx agentx-cli code claim ${code} --relay --wallet ${walletPath}`;
  try {
    const result = execSync(
      claimCmd,
      { encoding: "utf-8", timeout: 60000, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }
    );

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

async function claimFirstPostCampaign(
  walletPath: string,
  agentId: string,
  postId: number,
  account: AccountEntry
): Promise<{ success: boolean; error?: string }> {
  await setupAgentConfig(agentId, account);
  const tweetUrl = getDragonBallTweetUrl(account.twitterUsername);

  try {
    execSync(
      `npx agentx-cli campaign submit 0 --post-id ${postId} --tweet-url ${tweetUrl} --wallet ${walletPath} --relay`,
      { encoding: "utf-8", timeout: 60000, cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] }
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

export async function dragonBallFarm(): Promise<void> {
  const config = await loadAccounts();
  const eligible = config.accounts.filter((a) => a.status.registered);

  if (eligible.length === 0) {
    console.log(chalk.yellow("⚠️  No registered accounts. Run 'batch' first."));
    return;
  }

  console.log(chalk.bold(`\n🔮 Dragon Ball Farm — ${eligible.length} accounts\n`));

  let totalClaimed = 0;
  let totalPosts = 0;

  for (let i = 0; i < eligible.length; i++) {
    const account = eligible[i];
    const walletPath = await ensureWalletFile(account);

    console.log(
      chalk.bold(`  [${i + 1}/${eligible.length}] ${account.name} (${account.agentId})`)
    );

    const kp = getKeypair(account.privateKey);
    const conn = getConnection();
    const balance = await conn.getBalance(kp.publicKey);
    const balanceNara = balance / 1e9;
    if (balanceNara < MIN_POST_BALANCE) {
      console.log(chalk.yellow(`    ⚠️ Low balance (${balanceNara.toFixed(4)} NARA) — skipping post, checking DM only`));
      const codes = await checkDmInbox(walletPath);
      if (codes.length > 0) {
        console.log(chalk.cyan(`    📬 Found ${codes.length} code(s)`));
        for (const db of codes) {
          console.log(chalk.gray(`    → Claiming ${db.code.slice(0, 12)}...`));
          const tweetUrl = account.status.twitterBound
            ? getDragonBallTweetUrl(account.twitterUsername)
            : undefined;
          const result = await claimCode(walletPath, db.code, tweetUrl);
          if (result.success) {
            console.log(chalk.green(`    ✅ Claimed! tx: ${result.tx?.slice(0, 20)}...`));
            totalClaimed++;
          } else if (result.error === "already-claimed") {
            console.log(chalk.gray("    — Already claimed"));
          } else {
            console.log(chalk.red(`    ❌ ${result.error}`));
          }
        }
      }
      if (i < eligible.length - 1) await sleep(3000);
      continue;
    }

    console.log(chalk.gray("    → Creating post..."));
    const postId = await createPost(walletPath, account.agentId, account);
    if (postId) {
      console.log(chalk.green(`    ✅ Post #${postId}`));
      totalPosts++;
    } else {
      console.log(chalk.yellow("    ⚠️ Post failed, checking DM anyway..."));
    }

    console.log(chalk.gray("    → Waiting 10s for DM..."));
    await sleep(10000);

    console.log(chalk.gray("    → Checking DM inbox..."));
    const codes = await checkDmInbox(walletPath);

    if (codes.length === 0) {
      console.log(chalk.gray("    — No Dragon Ball codes found"));
    } else {
      console.log(chalk.cyan(`    📬 Found ${codes.length} code(s)`));

      for (const db of codes) {
        console.log(chalk.gray(`    → Claiming ${db.code.slice(0, 12)}...`));
        const tweetUrl = account.status.twitterBound
          ? getDragonBallTweetUrl(account.twitterUsername)
          : undefined;
        const result = await claimCode(walletPath, db.code, tweetUrl);
        if (result.success) {
          console.log(chalk.green(`    ✅ Claimed! tx: ${result.tx?.slice(0, 20)}...`));
          totalClaimed++;
        } else if (result.error === "already-claimed") {
          console.log(chalk.gray("    — Already claimed"));
        } else if (result.error === "expired") {
          console.log(chalk.yellow("    ⏰ Expired"));
        } else {
          console.log(chalk.red(`    ❌ ${result.error}`));
        }
      }
    }

    if (postId && !account.status.done) {
      console.log(chalk.gray("    → Trying first post campaign..."));
      const campaign = await claimFirstPostCampaign(walletPath, account.agentId, postId, account);
      if (campaign.success) {
        console.log(chalk.green("    ✅ First post campaign claimed! (+10 NARA)"));
        account.status.done = true;
        await saveAccounts(config);
      } else if (campaign.error === "already-claimed") {
        console.log(chalk.gray("    — Campaign already claimed"));
        account.status.done = true;
        await saveAccounts(config);
      } else {
        console.log(chalk.yellow(`    ⚠️ Campaign: ${campaign.error}`));
      }
    }

    if (i < eligible.length - 1) {
      console.log(chalk.gray("    ⏳ 5s delay..."));
      await sleep(5000);
    }
  }

  console.log(chalk.bold("\n═══════════════════════════════════════════"));
  console.log(chalk.bold("        🔮 DRAGON BALL FARM RESULTS"));
  console.log(chalk.bold("═══════════════════════════════════════════"));
  console.log(chalk.cyan(`  Posts created: ${totalPosts}`));
  console.log(chalk.green(`  Dragon Balls claimed: ${totalClaimed}`));
  console.log(chalk.gray(`  Accounts processed: ${eligible.length}\n`));
}
