import { Connection, Keypair } from "@solana/web3.js";
import fs from "fs-extra";
import path from "path";
import bs58 from "bs58";
import "dotenv/config";

export const RPC_URL = process.env.RPC_URL || "https://mainnet-api.nara.build/";
export const REFERRAL_AGENT_ID = process.env.REFERRAL_AGENT_ID || "";
export const FUNDING_PRIVATE_KEY = process.env.FUNDING_PRIVATE_KEY || "";

export interface AccountEntry {
  name: string;
  privateKey: string;
  walletAddress?: string;
  twitterUsername: string;
  agentId: string;
  tweetUrl?: string;
  status: {
    registered: boolean;
    twitterBound: boolean;
    tweetSubmitted: boolean;
    done: boolean;
  };
}

export interface AccountsConfig {
  accounts: AccountEntry[];
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");

export function getConnection(): Connection {
  return new Connection(RPC_URL, "confirmed");
}

export function getKeypair(privateKey: string): Keypair {
  const decoded = bs58.decode(privateKey);
  return Keypair.fromSecretKey(decoded);
}

export async function loadAccounts(): Promise<AccountsConfig> {
  await fs.ensureDir(DATA_DIR);
  if (!(await fs.pathExists(ACCOUNTS_FILE))) {
    const defaultConfig: AccountsConfig = { accounts: [] };
    await fs.writeJson(ACCOUNTS_FILE, defaultConfig, { spaces: 2 });
    return defaultConfig;
  }
  return fs.readJson(ACCOUNTS_FILE);
}

export async function saveAccounts(config: AccountsConfig): Promise<void> {
  await fs.ensureDir(DATA_DIR);
  await fs.writeJson(ACCOUNTS_FILE, config, { spaces: 2 });
}

// regex: extract numeric tweet ID from x.com/user/status/DIGITS URL format
export function extractTweetId(tweetUrl: string): bigint {
  const match = tweetUrl.match(/status\/(\d+)/);
  if (!match) throw new Error(`Invalid tweet URL: ${tweetUrl}`);
  return BigInt(match[1]);
}

export function generateBindTweetText(agentId: string): string {
  return `Verifying my agent "${agentId}" on @NaraBuildAI #NaraChain`;
}
