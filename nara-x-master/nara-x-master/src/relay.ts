import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { RPC_URL } from "./config.js";

const RELAY_URL = "https://quest-api.nara.build";

interface RelayResponse {
  transaction?: string;
  error?: string;
}

async function relaySignAndSend(
  connection: Connection,
  wallet: Keypair,
  endpoint: string,
  body: Record<string, unknown>
): Promise<string> {
  const url = RELAY_URL + endpoint;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data: RelayResponse;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Relay returned invalid response: ${text.slice(0, 200)}`);
  }

  if (data.error) throw new Error(`Relay error: ${data.error}`);
  if (!data.transaction) throw new Error("Relay returned no transaction");

  const txBuf = Buffer.from(data.transaction, "base64");
  const tx = VersionedTransaction.deserialize(new Uint8Array(txBuf));
  tx.sign([wallet]);

  const sig = await connection.sendTransaction(tx, { maxRetries: 3 });
  return sig;
}

export async function relayRegisterAgent(
  connection: Connection,
  wallet: Keypair,
  agentId: string,
  referralAgentId?: string
): Promise<string> {
  const body: Record<string, unknown> = {
    authority: wallet.publicKey.toBase58(),
    agentId,
  };
  if (referralAgentId) body.referralAgentId = referralAgentId;
  return relaySignAndSend(connection, wallet, "/register-agent", body);
}

export async function relaySetTwitter(
  connection: Connection,
  wallet: Keypair,
  agentId: string,
  username: string,
  tweetUrl: string
): Promise<string> {
  return relaySignAndSend(connection, wallet, "/set-twitter", {
    authority: wallet.publicKey.toBase58(),
    agentId,
    username,
    tweetUrl,
  });
}

export async function relaySubmitTweet(
  connection: Connection,
  wallet: Keypair,
  agentId: string,
  tweetId: bigint
): Promise<string> {
  return relaySignAndSend(connection, wallet, "/submit-tweet", {
    authority: wallet.publicKey.toBase58(),
    agentId,
    tweetId: tweetId.toString(),
  });
}
