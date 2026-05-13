import { Connection } from '@solana/web3.js';
import { loadAccounts, getKeypair } from './src/config.js';

const c = new Connection('https://mainnet-api.nara.build/', 'confirmed');
const config = await loadAccounts();
const acc = config.accounts.find(a => a.name === 'auto-17');
if (acc) {
  const kp = getKeypair(acc.privateKey);
  const bal = await c.getBalance(kp.publicKey);
  console.log(`auto-17 (${acc.agentId})`);
  console.log(`Wallet: ${kp.publicKey.toBase58()}`);
  console.log(`Balance: ${bal / 1e9} NARA`);
}
