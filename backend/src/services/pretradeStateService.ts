import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { prisma } from '../index';

const PYTHON_DIR = path.join(__dirname, '../../..', 'python');
const STATUS_INQUISIT_PATH = path.join(PYTHON_DIR, 'status_inquisit.py');
const SPAWN_TIMEOUT_MS = 25_000;
const RECHECK_COOLDOWN_MS = 10 * 60 * 1000; // 10 min — avoid re-spawning every poll cycle

function getPythonBin(): string {
  return process.platform === 'win32' ? 'python' : 'python3';
}

/**
 * One-shot live pretrade spike-state check (status_inquisit.py --pretrade --once --json).
 * Not a polling loop — fired on incoming ORDER webhooks and proactively by the
 * live score poller when a candidate looks distribution-adjacent (see secWatchScanner.ts).
 *
 * Writes pretrade_state / pretrade_is_distribution / pretrade_checked_at onto the
 * TradeIntent so both the WALL card and (via intent_id) the linked Execution card
 * can show a DISTRIBUTION badge without re-running the check themselves.
 */
export async function checkPretradeStateOnce(ticker: string, intentId: string): Promise<void> {
  try {
    if (!fs.existsSync(STATUS_INQUISIT_PATH)) return;
    const tradierKey = process.env.TRADIER_API_KEY;
    if (!tradierKey) return;

    const args = [STATUS_INQUISIT_PATH, '--ticker', ticker.toUpperCase(), '--pretrade', '--once', '--json'];

    const output = await new Promise<string>((resolve) => {
      let buf = '';
      const proc = spawn(getPythonBin(), args, {
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', TRADIER_API_KEY: tradierKey },
      });
      proc.stdout.on('data', (d: Buffer) => { buf += d.toString(); });
      proc.stderr.on('data', () => {});
      proc.on('close', () => resolve(buf));
      proc.on('error', () => resolve(buf));
      setTimeout(() => { proc.kill(); resolve(buf); }, SPAWN_TIMEOUT_MS);
    });

    const jsonLine = output.trim().split('\n').reverse().find((l) => l.trimStart().startsWith('{'));
    if (!jsonLine) return;

    const parsed = JSON.parse(jsonLine);
    const state = typeof parsed.state === 'string' ? parsed.state : null;
    if (!state) return;

    await prisma.tradeIntent.update({
      where: { id: intentId },
      data: {
        pretrade_state: state,
        pretrade_is_distribution: state === 'DISTRIBUTION',
        pretrade_checked_at: new Date(),
      },
    });

    console.log(`🔎 Pretrade state: ${ticker.toUpperCase()} → ${state}`);
  } catch (err) {
    console.error('checkPretradeStateOnce error:', err);
  }
}

/**
 * Gate for the proactive trigger (Trigger 2): only re-check if this intent
 * looks distribution-adjacent and hasn't been checked recently.
 */
export function shouldProactivelyCheckPretrade(intent: {
  pretrade_checked_at: Date | null;
}, tier: string, activeSignals: string[]): boolean {
  const cooledDown = !intent.pretrade_checked_at ||
    Date.now() - intent.pretrade_checked_at.getTime() > RECHECK_COOLDOWN_MS;
  if (!cooledDown) return false;

  const highTier = tier === 'HIGH';
  const distributionCombo = activeSignals.includes('QUIET_DUMP_PROXY') && activeSignals.includes('VWAP_FAIL_S1');
  return highTier || distributionCombo;
}
