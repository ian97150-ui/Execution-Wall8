import { prisma } from '../index';
import { refreshLiveScore } from './secChecklistService';
import type { SecChecklist } from './secChecklistService';

/**
 * Captures a ScoreSnapshot at the moment an order enters the system.
 * Called fire-and-forget after every prisma.execution.create — never blocks the order flow.
 *
 * If no TradeIntent with a sec_checklist exists for the ticker, returns silently
 * and grade_snapshot stays null on the execution row.
 */
export async function captureGradeSnapshot(
  ticker: string,
  executionId: string,
  intentId?: string | null
): Promise<void> {
  const upper = ticker.toUpperCase();

  // Refresh price action + re-score → writes fresh sec_checklist to all active TradeIntent rows
  await refreshLiveScore(upper);

  // Read back the freshly-written checklist (prefer linked intent, fall back to ticker lookup)
  const intent = intentId
    ? await prisma.tradeIntent.findUnique({ where: { id: intentId } })
    : await prisma.tradeIntent.findFirst({
        where: {
          ticker: upper,
          status: { not: 'swiped_off' },
          sec_checklist: { not: null },
        },
        orderBy: { created_date: 'desc' },
      });

  if (!intent?.sec_checklist) return;

  let checklist: SecChecklist;
  try {
    checklist = JSON.parse(intent.sec_checklist);
  } catch {
    return;
  }

  if (!checklist.score_snapshot) return;

  await prisma.execution.update({
    where: { id: executionId },
    data: { grade_snapshot: JSON.stringify(checklist.score_snapshot) },
  });

  console.log(`📊 Grade snapshot: ${upper} score=${checklist.score_snapshot.score} bias=${checklist.bias} pre_fall=${checklist.score_snapshot.pre_fall_tier}`);
}
