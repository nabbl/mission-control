import { NextRequest, NextResponse } from 'next/server';
import { getLogEntries, clearLogEntries } from '@/lib/logger';

// GET /api/logs - Fetch recent log entries
export async function GET(request: NextRequest) {
  const since = request.nextUrl.searchParams.get('since') ?? undefined;
  const limit = parseInt(request.nextUrl.searchParams.get('limit') ?? '100', 10);

  const entries = getLogEntries(since, limit);
  return NextResponse.json({ entries });
}

// DELETE /api/logs - Clear all log entries
export async function DELETE() {
  clearLogEntries();
  return NextResponse.json({ success: true });
}
