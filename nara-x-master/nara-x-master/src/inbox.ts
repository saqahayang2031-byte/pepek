import { exec } from "child_process";
import { promisify } from "util";
import chalk from "chalk";
import fs from "fs-extra";
import path from "path";
import {
  AccountEntry,
  getKeypair,
  loadAccounts,
} from "./config.js";

const execAsync = promisify(exec);
const CONCURRENCY = 5;
const CLAIMED_FILE = path.resolve("data", "claimed-codes.json");

async function loadClaimedCodes(): Promise<Set<string>> {
  try {
    const arr = await fs.readJson(CLAIMED_FILE);
    return new Set(arr);
  } catch {
    return new Set();
  }
}

async function saveClaimedCodes(codes: Set<string>): Promise<void> {
  await fs.writeJson(CLAIMED_FILE, [...codes]);
}

async function ensureWalletFile(account: AccountEntry): Promise<string> {
  await fs.ensureDir(path.resolve("data", "wallets"));
  const walletPath = path.resolve("data", "wallets", `wallet-${account.agentId}.json`);
  const kp = getKeypair(account.privateKey);
  await fs.writeJson(walletPath, Array.from(kp.secretKey));
  return walletPath;
}

function getTweetUrl(twitterUsername: string): string {
  return `https://x.com/${twitterUsername}/status/2053769643647799499`;
}

interface InboxResult {
  name: string;
  codesFound: number;
  claimed: number;
  error?: string;
}

async function processInbox(account: AccountEntry, claimedCodes: Set<string>): Promise<InboxResult> {
  const result: InboxResult = { name: account.name, codesFound: 0, claimed: 0 };
  const walletPath = await ensureWalletFile(account);

  try {
    const { stdout } = await execAsync(
      `npx agentx-cli dm-inbox --limit 20 --wallet ${walletPath}`,
      { encoding: "utf-8", timeout: 30000, cwd: process.cwd() }
    );

    const codeMatches = stdout.match(/Code:\s*([a-f0-9]+\.[A-Za-z0-9]+)/g);
    if (!codeMatches || codeMatches.length === 0) return result;

    const allCodes = [...new Set(codeMatches.map((m) => m.replace(/Code:\s*/, "").trim()))];
    const newCodes = allCodes.filter((c) => !claimedCodes.has(c));
    result.codesFound = allCodes.length;

    if (newCodes.length === 0) return result;

    const tweetUrl = getTweetUrl(account.twitterUsername);

    const claims = newCodes.map(async (code) => {
      try {
        await execAsync(
          `npx agentx-cli code claim ${code} --tweet-url ${tweetUrl} --relay --wallet ${walletPath}`,
          { encoding: "utf-8", timeout: 60000, cwd: process.cwd() }
        );
        result.claimed++;
        claimedCodes.add(code);
      } catch {
        claimedCodes.add(code);
      }
    });
    await Promise.all(claims);
  } catch {
    result.error = "DM fetch failed";
  }

  return result;
}

export async function checkAllInbox(): Promise<void> {
  const config = await loadAccounts();
  const eligible = config.accounts.filter((a) => a.status.registered);

  if (eligible.length === 0) {
    console.log(chalk.yellow("⚠️  No registered accounts."));
    return;
  }

  console.log(chalk.bold(`\n📬 Checking DM Inbox — ${eligible.length} accounts (${CONCURRENCY} parallel)\n`));

  const claimedCodes = await loadClaimedCodes();
  const queue = [...eligible];
  let totalCodes = 0;
  let totalClaimed = 0;
  let processed = 0;

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      const account = queue.shift()!;
      processed++;
      const idx = processed;

      const result = await processInbox(account, claimedCodes);
      totalCodes += result.codesFound;
      totalClaimed += result.claimed;

      const prefix = chalk.gray(`  [${idx}/${eligible.length}] ${account.name.padEnd(12)} `);
      if (result.error) {
        console.log(prefix + chalk.gray("— " + result.error));
      } else if (result.codesFound === 0) {
        console.log(prefix + chalk.gray("— no codes"));
      } else if (result.claimed === 0) {
        console.log(prefix + chalk.gray(`${result.codesFound} code(s) — all already claimed`));
      } else {
        console.log(prefix + chalk.cyan(`${result.codesFound} code(s) → `) + chalk.green(`${result.claimed} claimed`));
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, eligible.length) }, () => worker());
  await Promise.all(workers);

  await saveClaimedCodes(claimedCodes);
  console.log(chalk.bold(`\n📊 Results: ${totalCodes} codes found, ${totalClaimed} newly claimed\n`));
}
