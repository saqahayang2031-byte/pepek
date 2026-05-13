import { getAgentTwitter } from "nara-sdk";
import {
  getConnection,
  getKeypair,
  loadAccounts,
  saveAccounts,
  extractTweetId,
  generateBindTweetText,
} from "./config.js";
import { relaySetTwitter, relaySubmitTweet } from "./relay.js";

export async function generateTweetTemplates(): Promise<void> {
  const config = await loadAccounts();
  const pending = config.accounts.filter(
    (a) => a.status.registered && !a.status.twitterBound
  );

  if (pending.length === 0) {
    console.log("✅ All accounts already have Twitter bound.");
    return;
  }

  console.log(`\n🐦 Tweet templates for ${pending.length} account(s):\n`);
  console.log("─".repeat(60));

  for (const account of pending) {
    const tweetText = generateBindTweetText(account.agentId);
    console.log(`\n  Account: ${account.name}`);
    console.log(`  Twitter: @${account.twitterUsername}`);
    console.log(`  Agent:   ${account.agentId}`);
    console.log(`  ┌─────────────────────────────────────────`);
    console.log(`  │ Tweet this:`);
    console.log(`  │ ${tweetText}`);
    console.log(`  └─────────────────────────────────────────`);
  }

  console.log("\n" + "─".repeat(60));
  console.log(
    "\n📌 After posting, update tweetUrl in data/accounts.json then run: npx tsx src/index.ts bind-twitter\n"
  );
}

export async function batchBindTwitter(): Promise<void> {
  const connection = getConnection();
  const config = await loadAccounts();

  const pending = config.accounts.filter(
    (a) => a.status.registered && !a.status.twitterBound && a.tweetUrl
  );

  if (pending.length === 0) {
    console.log("✅ No accounts ready for Twitter binding.");
    console.log("   Make sure tweetUrl is set in data/accounts.json");
    return;
  }

  console.log(`\n🔗 Binding Twitter for ${pending.length} account(s)...\n`);

  for (const account of pending) {
    try {
      const wallet = getKeypair(account.privateKey);

      try {
        const twitterInfo = await getAgentTwitter(connection, account.agentId);
        if (twitterInfo && twitterInfo.status > 0) {
          console.log(`  ✅ ${account.name} — Twitter already bound`);
          account.status.twitterBound = true;
          await saveAccounts(config);
          continue;
        }
      } catch {
        // not bound yet, proceed
      }

      const signature = await relaySetTwitter(
        connection,
        wallet,
        account.agentId,
        account.twitterUsername,
        account.tweetUrl!
      );

      console.log(`  ✅ ${account.name} (@${account.twitterUsername}) — bound! tx: ${signature}`);
      account.status.twitterBound = true;
      await saveAccounts(config);

      await sleep(2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${account.name} — FAILED: ${msg}`);
    }
  }

  console.log("\n🏁 Twitter binding batch complete.\n");
}

export async function batchSubmitTweet(): Promise<void> {
  const connection = getConnection();
  const config = await loadAccounts();

  const pending = config.accounts.filter(
    (a) => a.status.twitterBound && !a.status.tweetSubmitted && a.tweetUrl
  );

  if (pending.length === 0) {
    console.log("✅ All tweets already submitted.");
    return;
  }

  console.log(`\n📤 Submitting tweets for ${pending.length} account(s)...\n`);

  for (const account of pending) {
    try {
      const wallet = getKeypair(account.privateKey);
      const tweetId = extractTweetId(account.tweetUrl!);

      const signature = await relaySubmitTweet(
        connection,
        wallet,
        account.agentId,
        tweetId
      );

      console.log(`  ✅ ${account.name} — tweet submitted! tx: ${signature}`);
      account.status.tweetSubmitted = true;
      await saveAccounts(config);

      await sleep(2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${account.name} — FAILED: ${msg}`);
    }
  }

  console.log("\n🏁 Tweet submission batch complete.\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
