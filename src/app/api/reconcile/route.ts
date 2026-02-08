import { NextResponse } from 'next/server';
import { reconcile } from '@/lib/reconcile';
import { syslog } from '@/lib/logger';

let running = false;

/**
 * GET /api/reconcile — trigger reconciliation and return result.
 * Prevents concurrent runs via module-level lock.
 * The reconcile() function itself handles 30s debounce.
 */
export async function GET() {
  if (running) {
    return NextResponse.json({ ran: false, reason: 'already running' });
  }

  running = true;
  try {
    const result = await reconcile();
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    syslog('error', 'reconcile', `Reconciliation failed: ${msg}`);
    return NextResponse.json(
      { ran: false, error: msg },
      { status: 500 }
    );
  } finally {
    running = false;
  }
}
