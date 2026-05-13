import chalk from "chalk";
import { loadAccounts, getConnection, getKeypair, FUNDING_PRIVATE_KEY } from "./config.js";

const TOTAL_STEPS = 7;
const MAX_LOG_LINES = 12;
const MAX_RESULT_LINES = 10;

interface WorkerState {
  account: string;
  step: number;
  stepLabel: string;
}

interface DashboardState {
  mainBalance: number;
  totalAccounts: number;
  doneAccounts: number;
  failedAccounts: number;
  concurrency: number;
  workers: Map<number, WorkerState>;
  logs: string[];
  results: { name: string; ok: boolean; nara: number }[];
  finished: boolean;
  startTime: number;
}

const state: DashboardState = {
  mainBalance: 0,
  totalAccounts: 0,
  doneAccounts: 0,
  failedAccounts: 0,
  concurrency: 1,
  workers: new Map(),
  logs: [],
  results: [],
  finished: false,
  startTime: Date.now(),
};

function elapsed(): string {
  const ms = Date.now() - state.startTime;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function render() {
  const w = Math.min(process.stdout.columns || 72, 72);
  const line = "─".repeat(w);

  process.stdout.write("\x1b[2J\x1b[H");

  let out = "";
  out += chalk.cyan.bold("  ⚡ NARA Farm") + chalk.gray(` — ${state.concurrency} workers — ${elapsed()}\n`);
  out += chalk.gray(`  ${line}\n`);

  out += `  ${chalk.white("Main:")} ${chalk.green(state.mainBalance.toFixed(2) + " NARA")}`;
  out += `  ${chalk.white("Done:")} ${chalk.green(String(state.doneAccounts))}`;
  if (state.failedAccounts > 0) out += chalk.red(` ✗${state.failedAccounts}`);
  out += `/${state.totalAccounts}`;
  const remaining = state.totalAccounts - state.doneAccounts - state.failedAccounts;
  if (remaining > 0) out += `  ${chalk.yellow(remaining + " left")}`;
  out += "\n";
  out += chalk.gray(`  ${line}\n\n`);

  const activeWorkers = [...state.workers.entries()].sort((a, b) => a[0] - b[0]);
  if (activeWorkers.length > 0) {
    for (const [wId, ws] of activeWorkers) {
      const pct = TOTAL_STEPS > 0 ? Math.round((ws.step / TOTAL_STEPS) * 100) : 0;
      const barLen = 20;
      const filled = Math.round((pct / 100) * barLen);
      const bar = chalk.green("█".repeat(filled)) + chalk.gray("░".repeat(barLen - filled));
      out += `  ${chalk.yellow(`W${wId + 1}`)} ${chalk.bold(ws.account.padEnd(18).slice(0, 18))} ${bar} ${String(pct).padStart(3)}%`;
      out += `  ${chalk.cyan(ws.stepLabel)}\n`;
    }
  } else if (!state.finished) {
    out += chalk.gray("  Waiting...\n");
  }

  out += chalk.gray(`\n  ${line}\n`);

  out += chalk.gray("  Log:\n");
  const showLogs = state.logs.slice(-MAX_LOG_LINES);
  for (const l of showLogs) {
    out += `    ${l}\n`;
  }

  if (state.finished) {
    out += chalk.gray(`\n  ${line}\n`);
    const successRate = state.totalAccounts > 0
      ? Math.round((state.doneAccounts / state.totalAccounts) * 100)
      : 0;
    out += chalk.bold(`  ✅ Finished in ${elapsed()} — ${state.doneAccounts}/${state.totalAccounts} success (${successRate}%)\n`);
  }

  process.stdout.write(out);
}

export const ui = {
  get state() { return state; },

  async init(concurrency = 1) {
    state.concurrency = concurrency;
    state.startTime = Date.now();
    state.finished = false;
    state.workers.clear();
    state.logs = [];
    state.results = [];
    state.doneAccounts = 0;
    state.failedAccounts = 0;
    const config = await loadAccounts();
    state.totalAccounts = config.accounts.filter((a) => !a.status.done).length;
    try {
      const conn = getConnection();
      const funder = getKeypair(FUNDING_PRIVATE_KEY);
      state.mainBalance = (await conn.getBalance(funder.publicKey)) / 1e9;
    } catch {
      state.mainBalance = 0;
    }
    render();
  },

  setTotal(n: number) {
    state.totalAccounts = n;
    render();
  },

  log(msg: string) {
    state.logs.push(msg);
    if (state.logs.length > 200) state.logs = state.logs.slice(-100);
    render();
  },

  workerStart(workerId: number, account: string) {
    state.workers.set(workerId, { account, step: 0, stepLabel: "Starting..." });
    render();
  },

  workerStep(workerId: number, step: number, label: string) {
    const ws = state.workers.get(workerId);
    if (ws) {
      ws.step = step;
      ws.stepLabel = label;
      render();
    }
  },

  workerDone(workerId: number) {
    state.workers.delete(workerId);
    render();
  },

  addResult(name: string, ok: boolean, nara = 0) {
    state.results.push({ name, ok, nara });
    if (ok) state.doneAccounts++;
    else state.failedAccounts++;
    render();
  },

  updateBalance(bal: number) {
    state.mainBalance = bal;
    render();
  },

  finish() {
    state.finished = true;
    state.workers.clear();
    render();
    process.stdout.write("\x1b[?25h\n");
  },

  setAccount(name: string) {
    this.workerStart(0, name);
  },
  setStep(step: number, label: string) {
    this.workerStep(0, step, label);
  },
};
