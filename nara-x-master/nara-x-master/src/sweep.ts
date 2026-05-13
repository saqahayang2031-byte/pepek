import { Transaction, SystemProgram } from "@solana/web3.js";
import chalk from "chalk";
import { getConnection, getKeypair, loadAccounts, FUNDING_PRIVATE_KEY } from "./config.js";

const NARA_DECIMALS = 9;
const MIN_KEEP = 0.005;
const MIN_KEEP_LAMPORTS = MIN_KEEP * 10 ** NARA_DECIMALS;
const TX_BATCH_SIZE = 5;

export async function sweepAll(): Promise<void> {
  const connection = getConnection();
  const config = await loadAccounts();
  const mainWallet = getKeypair(FUNDING_PRIVATE_KEY);

  if (config.accounts.length === 0) {
    console.log(chalk.yellow("⚠️  No accounts."));
    return;
  }

  console.log(chalk.bold(`\n💸 Sweeping all NARA → ${mainWallet.publicKey.toBase58().slice(0, 12)}...\n`));

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

  const sweepable: { idx: number; amount: number }[] = [];
  for (let i = 0; i < balances.length; i++) {
    if (balances[i] > MIN_KEEP_LAMPORTS) {
      sweepable.push({ idx: i, amount: balances[i] - MIN_KEEP_LAMPORTS });
    }
  }

  if (sweepable.length === 0) {
    console.log(chalk.gray("  Nothing to sweep (all wallets below threshold)."));
    return;
  }

  console.log(chalk.gray(`  Found ${sweepable.length} wallets with balance to sweep\n`));

  let totalSent = 0;
  let successCount = 0;

  for (let batch = 0; batch < sweepable.length; batch += TX_BATCH_SIZE) {
    const chunk = sweepable.slice(batch, batch + TX_BATCH_SIZE);
    const { blockhash } = await connection.getLatestBlockhash("finalized");

    const sends = chunk.map(async ({ idx, amount }) => {
      const kp = keypairs[idx];
      const account = config.accounts[idx];
      const sendNara = amount / 10 ** NARA_DECIMALS;

      try {
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: mainWallet.publicKey,
            lamports: amount,
          })
        );
        tx.feePayer = kp.publicKey;
        tx.recentBlockhash = blockhash;
        tx.sign(kp);

        const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
        console.log(chalk.green(`  ✅ ${account.name.padEnd(12)} ${sendNara.toFixed(4)} NARA`));
        totalSent += sendNara;
        successCount++;
      } catch (err: unknown) {
        const msg = (err as Error).message || "";
        console.log(chalk.red(`  ❌ ${account.name.padEnd(12)} — ${msg.slice(0, 60)}`));
      }
    });

    await Promise.all(sends);
  }

  console.log(chalk.bold(`\n📊 Swept ${totalSent.toFixed(4)} NARA from ${successCount} wallets`));

  await new Promise((r) => setTimeout(r, 3000));
  const mainBal = await connection.getBalance(mainWallet.publicKey);
  console.log(chalk.cyan(`  Main wallet balance: ${(mainBal / 10 ** NARA_DECIMALS).toFixed(4)} NARA\n`));
}
