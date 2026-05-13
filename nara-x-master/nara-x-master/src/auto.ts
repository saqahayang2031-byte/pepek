import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import chalk from "chalk";
import { AccountEntry, loadAccounts, saveAccounts } from "./config.js";
import { batchRun } from "./batch.js";

function randomUsername(): string {
  const prefixes = ["nara", "agent", "ai", "web3", "defi", "sol", "zk", "node"];
  const prefix = prefixes[Math.floor(Math.random() * prefixes.length)];
  const suffix = Math.random().toString(36).slice(2, 7);
  return `${prefix}${suffix}`;
}

function generateAgentId(username: string): string {
  const base = username.toLowerCase().replace(/[^a-z0-9]/g, "");
  const id = `${base}-nara`;
  return id.length >= 8 ? id : id.padEnd(8, "x");
}

async function askNumber(prompt: string, min: number, max: number, defaultVal?: number): Promise<number> {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultVal ? ` [default: ${defaultVal}]` : "";
  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.cyan(`${prompt}${suffix}: `), resolve);
  });
  rl.close();
  const val = answer.trim() ? parseInt(answer.trim(), 10) : (defaultVal || 0);
  if (!val || val < min || val > max) {
    console.log(chalk.red(`❌ Masukkin angka ${min}-${max}`));
    return -1;
  }
  return val;
}

export async function autoRun(countArg?: string): Promise<void> {
  let count: number;
  let concurrency: number;

  if (countArg) {
    const parts = countArg.split(",");
    count = parseInt(parts[0], 10);
    concurrency = parts[1] ? parseInt(parts[1], 10) : 1;
  } else {
    count = await askNumber("🤖 Mau jalanin berapa akun?", 1, 999999);
    if (count < 0) return;

    concurrency = await askNumber("⚡ Paralel berapa worker?", 1, 20, 3);
    if (concurrency < 0) return;
  }

  if (!count || count < 1) {
    console.log(chalk.red("❌ Masukkin angka minimal 1"));
    return;
  }
  if (!concurrency || concurrency < 1) concurrency = 1;
  if (concurrency > 20) concurrency = 20;

  const config = await loadAccounts();
  const existingAgentIds = new Set(config.accounts.map((a) => a.agentId));

  console.log(chalk.cyan(`\n🤖 Generating ${count} accounts, ${concurrency} parallel workers...\n`));

  let added = 0;
  for (let i = 0; i < count; i++) {
    let username = randomUsername();
    let agentId = generateAgentId(username);

    let attempts = 0;
    while (existingAgentIds.has(agentId) && attempts < 10) {
      username = randomUsername();
      agentId = generateAgentId(username);
      attempts++;
    }

    if (existingAgentIds.has(agentId)) {
      agentId = `${agentId}${Date.now().toString(36).slice(-3)}`;
    }

    const kp = Keypair.generate();
    const privateKey = bs58.encode(kp.secretKey);

    const entry: AccountEntry = {
      name: `auto-${config.accounts.length + 1}`,
      privateKey,
      twitterUsername: username,
      agentId,
      tweetUrl: "",
      walletAddress: kp.publicKey.toBase58(),
      status: {
        registered: false,
        twitterBound: false,
        tweetSubmitted: false,
        done: false,
      },
    };

    config.accounts.push(entry);
    existingAgentIds.add(agentId);
    added++;
  }

  await saveAccounts(config);

  const newAccountNames = config.accounts.slice(-added).map((a) => a.name);

  console.log(chalk.green(`✅ Generated ${added} new accounts`));
  console.log(chalk.cyan(`   Total: ${config.accounts.length} | Workers: ${concurrency}`));

  await batchRun(true, newAccountNames, concurrency);
}
