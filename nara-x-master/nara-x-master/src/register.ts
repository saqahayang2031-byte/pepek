import { getAgentRecord } from "nara-sdk";
import {
  getConnection,
  getKeypair,
  loadAccounts,
  saveAccounts,
  REFERRAL_AGENT_ID,
} from "./config.js";
import { relayRegisterAgent } from "./relay.js";

export async function batchRegisterAgents(): Promise<void> {
  const connection = getConnection();
  const config = await loadAccounts();

  const pending = config.accounts.filter((a) => !a.status.registered);
  if (pending.length === 0) {
    console.log("✅ All agents already registered.");
    return;
  }

  console.log(`\n📝 Registering ${pending.length} agent(s) via relay (gasless)...\n`);

  for (const account of pending) {
    try {
      const wallet = getKeypair(account.privateKey);

      try {
        const existing = await getAgentRecord(connection, account.agentId);
        if (existing) {
          console.log(`  ✅ ${account.name} (${account.agentId}) — already on-chain`);
          account.status.registered = true;
          await saveAccounts(config);
          continue;
        }
      } catch {
        // not found on-chain, proceed
      }

      const signature = await relayRegisterAgent(
        connection,
        wallet,
        account.agentId,
        REFERRAL_AGENT_ID || undefined
      );

      console.log(`  ✅ ${account.name} (${account.agentId}) — registered! tx: ${signature}`);
      account.status.registered = true;
      await saveAccounts(config);

      await sleep(2000);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ❌ ${account.name} (${account.agentId}) — FAILED: ${msg}`);
    }
  }

  console.log("\n🏁 Registration batch complete.\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
