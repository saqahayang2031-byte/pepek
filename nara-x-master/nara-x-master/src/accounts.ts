import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import { AccountEntry, loadAccounts, saveAccounts } from "./config.js";

function generateAgentId(twitterUsername: string, index: number): string {
  const base = twitterUsername.toLowerCase().replace(/[^a-z0-9]/g, "");
  const suffix = `-nara-${index}`;
  const maxBase = 20 - suffix.length;
  const trimmed = base.slice(0, maxBase);
  return `${trimmed}${suffix}`;
}

export async function importFromFile(): Promise<void> {
  const filePath = path.resolve(process.cwd(), "data", "twitter-list.txt");

  if (!(await fs.pathExists(filePath))) {
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, "# Satu username per baris (tanpa @)\n# Contoh:\n# achwir_\n# user123\n");
    console.log(chalk.yellow(`\n📝 File dibuat: data/twitter-list.txt`));
    console.log(chalk.yellow(`   Isi dengan username Twitter (satu per baris), lalu jalanin lagi.\n`));
    return;
  }

  const raw = await fs.readFile(filePath, "utf-8");
  const usernames = raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));

  if (usernames.length === 0) {
    console.log(chalk.yellow("⚠️  data/twitter-list.txt kosong. Isi dulu username-nya."));
    return;
  }

  const config = await loadAccounts();
  const existingTwitters = new Set(config.accounts.map((a) => a.twitterUsername));
  const existingAgentIds = new Set(config.accounts.map((a) => a.agentId));

  let added = 0;
  let skipped = 0;

  for (let i = 0; i < usernames.length; i++) {
    const username = usernames[i].replace(/^@/, "");

    if (existingTwitters.has(username)) {
      skipped++;
      continue;
    }

    let agentId = generateAgentId(username, i + 1);
    let attempt = 1;
    while (existingAgentIds.has(agentId)) {
      attempt++;
      agentId = generateAgentId(username, i + attempt * 100);
    }

    if (agentId.length < 8) {
      agentId = agentId.padEnd(8, "x");
    }

    const kp = Keypair.generate();
    const privateKey = bs58.encode(kp.secretKey);

    const entry: AccountEntry = {
      name: `acc-${added + 1}`,
      privateKey,
      twitterUsername: username,
      agentId,
      tweetUrl: "",
      status: {
        registered: false,
        twitterBound: false,
        tweetSubmitted: false,
        done: false,
      },
    };

    config.accounts.push(entry);
    existingTwitters.add(username);
    existingAgentIds.add(agentId);
    added++;
  }

  await saveAccounts(config);

  console.log(chalk.green(`\n✅ Import selesai!`));
  console.log(chalk.cyan(`   Ditambahkan: ${added} akun baru`));
  console.log(chalk.gray(`   Di-skip (duplikat): ${skipped}`));
  console.log(chalk.cyan(`   Total akun sekarang: ${config.accounts.length}`));
  console.log(chalk.gray(`\n   Jalanin 'npx tsx src/index.ts batch' untuk mulai.\n`));
}

export async function addAccount(args: string[]): Promise<void> {
  const [name, twitterUsername, agentId] = args;

  if (!name || !twitterUsername || !agentId) {
    console.log(`
  Usage: npx tsx src/index.ts add-account <name> <twitterUsername> <agentId>

  Example:
    npx tsx src/index.ts add-account akun-1 achwir_ my-cool-agent

  Wallet is auto-generated.
`);
    return;
  }

  const kp = Keypair.generate();
  const privateKey = bs58.encode(kp.secretKey);

  if (agentId.length < 8) {
    console.log("⚠️  Agent ID < 8 chars will cost NARA to register. 8+ chars = free.");
  }

  if (/[A-Z]/.test(agentId)) {
    console.error("❌ Agent ID must be lowercase only");
    return;
  }

  const config = await loadAccounts();

  const duplicate = config.accounts.find(
    (a) => a.agentId === agentId || a.twitterUsername === twitterUsername
  );
  if (duplicate) {
    console.error(`❌ Duplicate found: agent "${agentId}" or twitter "@${twitterUsername}" already exists`);
    return;
  }

  const entry: AccountEntry = {
    name,
    privateKey,
    twitterUsername,
    agentId,
    tweetUrl: "",
    status: {
      registered: false,
      twitterBound: false,
      tweetSubmitted: false,
      done: false,
    },
  };

  config.accounts.push(entry);
  await saveAccounts(config);

  console.log(`✅ Added account "${name}"`);
  console.log(`   Wallet: ${kp.publicKey.toBase58()}`);
  console.log(`   Private Key: ${privateKey}`);
  console.log(`   Twitter: @${twitterUsername}`);
  console.log(`   Agent ID: ${agentId}`);
}

export async function generateWallet(): Promise<void> {
  const kp = Keypair.generate();
  console.log(`\n🔑 New Wallet Generated:`);
  console.log(`   Public Key:  ${kp.publicKey.toBase58()}`);
  console.log(`   Private Key: ${bs58.encode(kp.secretKey)}`);
  console.log(`\n   ⚠️  Save the private key securely!\n`);
}
