import { Transaction, SystemProgram } from "@solana/web3.js";
import chalk from "chalk";
import { getConnection, getKeypair, loadAccounts, FUNDING_PRIVATE_KEY } from "./config.js";

const NARA_DECIMALS = 9;
// Buffer saldo yang di-reserve di funding wallet untuk fee
const FUNDER_MIN_RESERVE = 0.01;

async function askString(prompt: string, defaultVal?: string): Promise<string> {
  const { createInterface } = await import("readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const suffix = defaultVal !== undefined ? ` [default: ${defaultVal}]` : "";
  const answer = await new Promise<string>((resolve) => {
    rl.question(chalk.cyan(`${prompt}${suffix}: `), resolve);
  });
  rl.close();
  return answer.trim() || (defaultVal ?? "");
}

export async function fundAll(amountArg?: string, concurrencyArg?: string): Promise<void> {
  const connection = getConnection();
  const config = await loadAccounts();

  if (config.accounts.length === 0) {
    console.log(chalk.yellow("⚠️  No accounts. Generate dulu pakai 'auto' atau 'add-account'."));
    return;
  }

  if (!FUNDING_PRIVATE_KEY) {
    console.log(chalk.red("❌ FUNDING_PRIVATE_KEY gak ada di .env"));
    return;
  }

  const funder = getKeypair(FUNDING_PRIVATE_KEY);

  // --- Input amount ---
  let amount: number;
  if (amountArg) {
    amount = parseFloat(amountArg);
  } else {
    const amountStr = await askString("💰 Amount per wallet (NARA)", "0.2");
    amount = parseFloat(amountStr);
  }
  if (isNaN(amount) || amount <= 0) {
    console.log(chalk.red("❌ Amount invalid"));
    return;
  }
  const amountLamports = Math.floor(amount * 10 ** NARA_DECIMALS);

  // --- Input: skip wallet yang sudah cukup? ---
  let skipFunded = true;
  if (!amountArg) {
    const skipAns = await askString("🔁 Skip wallet yang saldo >= amount? (Y/n)", "y");
    skipFunded = skipAns.toLowerCase() !== "n";
  }

  // --- Input: paralel ---
  let concurrency: number;
  if (concurrencyArg) {
    concurrency = parseInt(concurrencyArg, 10);
  } else if (amountArg) {
    concurrency = 5;
  } else {
    const concAns = await askString("⚡ Paralel berapa tx per batch?", "5");
    concurrency = parseInt(concAns, 10);
  }
  if (isNaN(concurrency) || concurrency < 1) concurrency = 1;
  if (concurrency > 20) concurrency = 20;

  console.log(
    chalk.bold(`\n💸 Funding sub-wallets — ${amount} NARA each, ${concurrency} parallel tx/batch\n`)
  );

  // --- Ambil balance semua sub-wallet ---
  const keypairs = config.accounts.map((a) => getKeypair(a.privateKey));
  const pubkeys = keypairs.map((kp) => kp.publicKey);

  const balances: number[] = [];
  for (let i = 0; i < pubkeys.length; i += 100) {
    const batch = pubkeys.slice(i, i + 100);
    const infos = await connection.getMultipleAccountsInfo(batch);
    for (const info of infos) {
      balances.push(info ? info.lamports : 0);
    }
  }

  // --- Filter target ---
  const targets: number[] = [];
  let skipped = 0;
  for (let i = 0; i < pubkeys.length; i++) {
    if (skipFunded && balances[i] >= amountLamports) {
      skipped++;
      continue;
    }
    targets.push(i);
  }

  if (targets.length === 0) {
    console.log(chalk.gray(`  Nothing to fund. ${skipped} wallet sudah punya >= ${amount} NARA.\n`));
    return;
  }

  // --- Cek saldo funder ---
  const funderLamports = await connection.getBalance(funder.publicKey);
  const funderNara = funderLamports / 10 ** NARA_DECIMALS;
  const totalNeeded = amount * targets.length;

  console.log(chalk.gray(`  Funder:       ${funder.publicKey.toBase58()}`));
  console.log(chalk.gray(`  Funder bal:   ${funderNara.toFixed(4)} NARA`));
  console.log(chalk.gray(`  Targets:      ${targets.length} wallet (skip ${skipped})`));
  console.log(chalk.gray(`  Total needed: ${totalNeeded.toFixed(4)} NARA (+ fees)\n`));

  if (funderNara < totalNeeded + FUNDER_MIN_RESERVE) {
    console.log(
      chalk.red(
        `❌ Saldo funder kurang. Butuh ${(totalNeeded + FUNDER_MIN_RESERVE).toFixed(4)} NARA, ada ${funderNara.toFixed(4)}.`
      )
    );
    return;
  }

  // --- Kirim per-batch paralel ---
  let successCount = 0;
  let failCount = 0;
  let totalSent = 0;

  for (let b = 0; b < targets.length; b += concurrency) {
    const chunk = targets.slice(b, b + concurrency);
    const { blockhash } = await connection.getLatestBlockhash("finalized");

    const sends = chunk.map(async (idx) => {
      const account = config.accounts[idx];
      const targetPk = pubkeys[idx];

      try {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: funder.publicKey,
            toPubkey: targetPk,
            lamports: amountLamports,
          })
        );
        tx.feePayer = funder.publicKey;
        tx.recentBlockhash = blockhash;
        tx.sign(funder);

        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        console.log(
          chalk.green(
            `  ✅ ${account.name.padEnd(14)} ${targetPk.toBase58().slice(0, 8)}…  ${amount} NARA  (${sig.slice(0, 10)}…)`
          )
        );
        totalSent += amount;
        successCount++;
      } catch (err: unknown) {
        const msg = (err as Error).message || "";
        console.log(
          chalk.red(
            `  ❌ ${account.name.padEnd(14)} ${targetPk.toBase58().slice(0, 8)}…  — ${msg.slice(0, 60)}`
          )
        );
        failCount++;
      }
    });

    await Promise.all(sends);
  }

  console.log(
    chalk.bold(
      `\n📊 Sent ${totalSent.toFixed(4)} NARA — ${successCount} ok, ${failCount} failed, ${skipped} skipped`
    )
  );

  await new Promise((r) => setTimeout(r, 3000));
  const finalBal = await connection.getBalance(funder.publicKey);
  console.log(
    chalk.cyan(`  Funding wallet balance: ${(finalBal / 10 ** NARA_DECIMALS).toFixed(4)} NARA\n`)
  );
}
