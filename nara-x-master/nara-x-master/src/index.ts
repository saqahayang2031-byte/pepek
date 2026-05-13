import chalk from "chalk";
import { loadAccounts, saveAccounts, getConnection, getKeypair, FUNDING_PRIVATE_KEY } from "./config.js";
import { batchRun, batchCheckBalances } from "./batch.js";
import { dragonBallFarm } from "./dragonball.js";
import { autoRun } from "./auto.js";
import { checkAllInbox } from "./inbox.js";
import { sweepAll } from "./sweep.js";
import { fundAll } from "./fund.js";
import { batchRegisterAgents } from "./register.js";
import { generateTweetTemplates, batchBindTwitter, batchSubmitTweet } from "./twitter.js";
import { addAccount, generateWallet, importFromFile } from "./accounts.js";

const COMMANDS: Record<string, () => Promise<void>> = {
  auto: () => autoRun(process.argv[3]),
  import: importFromFile,
  batch: batchRun,
  farm: dragonBallFarm,
  inbox: checkAllInbox,
  sweep: sweepAll,
  fund: () => fundAll(process.argv[3], process.argv[4]),
  balances: batchCheckBalances,
  register: batchRegisterAgents,
  "tweet-templates": generateTweetTemplates,
  "bind-twitter": batchBindTwitter,
  "submit-tweet": batchSubmitTweet,
  status: showStatus,
  "run-all": runAll,
  "agentx-guide": showAgentXGuide,
  "add-account": () => addAccount(process.argv.slice(3)),
  "gen-wallet": generateWallet,
};


async function showStatus(): Promise<void> {
  const config = await loadAccounts();
  if (config.accounts.length === 0) {
    console.log("⚠️  No accounts configured.");
    return;
  }
  console.log(`\n📊 Status (${config.accounts.length} accounts):\n`);
  console.log("  Name".padEnd(20) + "Agent ID".padEnd(25) + "Reg".padEnd(6) + "Twitter".padEnd(10) + "Tweet".padEnd(8) + "Done");
  console.log("  " + "─".repeat(75));
  for (const a of config.accounts) {
    const row = `  ${a.name}`.padEnd(20) + a.agentId.padEnd(25) +
      (a.status.registered ? "✅" : "❌").padEnd(6) +
      (a.status.twitterBound ? "✅" : "❌").padEnd(10) +
      (a.status.tweetSubmitted ? "✅" : "❌").padEnd(8) +
      (a.status.done ? "✅" : "❌");
    console.log(row);
  }
  console.log();
}

async function runAll(): Promise<void> {
  await batchRegisterAgents();
  await generateTweetTemplates();
  const config = await loadAccounts();
  const needsUrls = config.accounts.some((a) => a.status.registered && !a.status.twitterBound && !a.tweetUrl);
  if (needsUrls) {
    console.log("\n⏸️  PAUSED: Post tweets, add tweetUrl to accounts.json, then run again.");
    return;
  }
  await batchBindTwitter();
  await batchSubmitTweet();
  const finalConfig = await loadAccounts();
  for (const a of finalConfig.accounts) {
    if (a.status.registered && a.status.twitterBound && a.status.tweetSubmitted) a.status.done = true;
  }
  await saveAccounts(finalConfig);
  await showStatus();
}

async function showAgentXGuide(): Promise<void> {
  console.log(`
  AgentX First Post Guide:
  1. Go to https://agentx.nara.build
  2. Connect wallet → Stake 0.01 NARA → Post → Share on X
  3. Submit campaign → Check DM for API Key
  Reward: 20 NARA + 50 NARA API Key
`);
}

async function getMainBalance(): Promise<number> {
  try {
    const conn = getConnection();
    const funder = getKeypair(FUNDING_PRIVATE_KEY);
    const bal = await conn.getBalance(funder.publicKey);
    return bal / 1e9;
  } catch {
    return 0;
  }
}

async function batchPendingWithConcurrency(): Promise<void> {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.cyan("  ⚡ Paralel berapa worker? [default: 3]: "), resolve);
  });
  rl.close();
  const concurrency = Math.max(1, Math.min(20, parseInt(answer.trim(), 10) || 3));
  await batchRun(true, undefined, concurrency);
}

async function interactiveMenu(): Promise<void> {
  const { createInterface } = await import("readline");
  const config = await loadAccounts();
  const done = config.accounts.filter((a) => a.status.done).length;
  const pending = config.accounts.length - done;
  const mainBal = await getMainBalance();

  const width = Math.min(process.stdout.columns || 60, 60);
  const line = "─".repeat(width);

  process.stdout.write("\x1b[2J\x1b[H");

  console.log(chalk.cyan.bold(`\n  ⚡ NARA Farm`));
  console.log(chalk.gray(`  ${line}`));
  console.log(`  ${chalk.white("Main Wallet:")} ${chalk.green(mainBal.toFixed(4) + " NARA")}`);
  console.log(`  ${chalk.white("Accounts:")}    ${chalk.green(String(done))} done, ${chalk.yellow(String(pending))} pending, ${chalk.gray(String(config.accounts.length))} total`);
  console.log(chalk.gray(`  ${line}\n`));

  console.log(`  ${chalk.green("1")}  🚀 Auto ${chalk.gray("— generate N akun + run parallel")}`);
  console.log(`  ${chalk.green("2")}  🔄 Batch Pending ${chalk.gray("— run pending accounts parallel")}`);
  console.log(`  ${chalk.green("3")}  📬 Inbox ${chalk.gray("— cek DM semua akun + claim codes")}`);
  console.log(`  ${chalk.green("4")}  💸 Sweep ${chalk.gray("— kirim semua NARA ke main wallet")}`);
  console.log(`  ${chalk.green("5")}  💰 Balances ${chalk.gray("— cek saldo semua wallet")}`);
  console.log(`  ${chalk.green("6")}  📊 Status ${chalk.gray("— lihat status semua akun")}`);
  console.log(`  ${chalk.green("7")}  🏦 Fund ${chalk.gray("— transfer NARA dari funding ke semua sub-wallet")}`);
  console.log();
  console.log(chalk.gray(`  ${line}`));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.cyan("\n  ▶ Pilih (1-7): "), resolve);
  });
  rl.close();

  console.log();

  switch (answer.trim()) {
    case "1": await autoRun(); break;
    case "2": await batchPendingWithConcurrency(); break;
    case "3": await checkAllInbox(); break;
    case "4": await sweepAll(); break;
    case "5": await batchCheckBalances(); break;
    case "6": await showStatus(); break;
    case "7": await fundAll(); break;
    default: console.log(chalk.red("  ❌ Pilihan gak valid"));
  }
}

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command) {
    await interactiveMenu();
    return;
  }

  if (!COMMANDS[command]) {
    console.log(chalk.red(`❌ Unknown command: ${command}`));
    return;
  }

  await COMMANDS[command]();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
