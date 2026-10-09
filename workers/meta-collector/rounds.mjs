// MAROOWELL realtime lifecycle, adapted for TO:NEST's three night rounds.
// Timestamps without an offset are KST database timestamps, never UTC.
export const expectedRounds = batch => String(batch?.wave || '').toUpperCase() === 'WAVE1' ? 3 : 2;
export function tsMs(value) {
  if (!value) return NaN;
  const s = String(value).replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(s) ? s : `${s}+09:00`);
}
export const kstIso = ms => new Date(ms + 9 * 3600000).toISOString().slice(0, -1);
const n = value => Math.max(0, Number(value) || 0);
function roundFields(prev, round) {
  return {
    scan: prev?.[`round${round}_scan_started_at`] || (round === 1 ? prev?.scan_started_at : null) || null,
    delivery: prev?.[`round${round}_delivery_started_at`] || (round === 1 ? prev?.delivery_started_at : null) || null,
    completed: prev?.[`round${round}_completed_at`] || null,
    detected: prev?.[`round${round}_completion_detected_at`] || null,
    method: prev?.[`round${round}_completion_method`] || null
  };
}
export function advanceProgress(prev, d, ret, fb, batch, now) {
  const expRounds = expectedRounds(batch), night = batch.wave === 'WAVE1';
  const pairs = [
    [prev?.delivery_assigned, d.assigned], [prev?.delivery_scanned, d.scanned],
    [prev?.delivery_completed, d.completed], [prev?.delivery_impossible, d.impossible],
    [prev?.delivery_pdd_miss, d.pdd], [prev?.delivery_total, d.total],
    [prev?.freshbag_pending, fb.pending], [prev?.freshbag_collected, fb.collected],
    [prev?.freshbag_uncollected, fb.uncollected]
  ];
  if (!night) pairs.push([prev?.return_pending,ret?.pending], [prev?.return_collected,ret?.collected],
    [prev?.return_uncollected_raw,ret?.rawUn], [prev?.return_absent_raw,ret?.rawAbsent]);
  const changed = !prev || pairs.some(([a,b]) => n(a) !== n(b));
  // Assignment alone is not a scan, cancellation/PDD is not a delivery.
  const scanMoved = prev ? n(d.scanned) > n(prev.delivery_scanned)
    || (n(d.total) > n(prev.delivery_total) && n(d.scanned) > 0)
    : n(d.scanned) > 0 || n(d.completed) > 0;
  const deliveryMoved = n(d.completed) > n(prev?.delivery_completed);
  let currentRound = Math.max(1, Math.min(expRounds, n(prev?.current_round) || 1));
  const rounds = {1:roundFields(prev,1),2:roundFields(prev,2),3:roundFields(prev,3)};
  let lastProgressAt = changed ? now : (prev?.last_progress_at || now);
  let lastScanActivityAt = scanMoved ? now : (prev?.last_scan_activity_at || null);
  if (!rounds[1].scan && (n(d.scanned) > 0 || n(d.completed) > 0)) rounds[1].scan = now;
  // Classify a round change before assigning this poll's first delivery time.
  let advanced = false;
  if (rounds[currentRound].completed && scanMoved && currentRound < expRounds) {
    currentRound += 1; advanced = true;
    rounds[currentRound].scan ||= now;
    lastProgressAt = now; lastScanActivityAt = now;
  }
  if (deliveryMoved) rounds[currentRound].delivery ||= now;
  const deliveryDone = n(d.total) > 0 && n(d.scanned) === 0;
  const returnDone = night || n(ret?.pending) === 0;
  const freshbagDone = n(fb.pending) === 0;
  const exactDone = deliveryDone && returnDone && freshbagDone;
  const deliveryRemaining = n(d.scanned), returnRemaining = night ? 0 : n(ret?.pending);
  const freshbagRemaining = n(fb.pending), totalRemaining = deliveryRemaining+returnRemaining+freshbagRemaining;
  const idleMinutes = Math.max(0,(tsMs(now)-tsMs(lastProgressAt))/60000) || 0;
  const invalidOldCompletion = !!prev?.work_completed_at && (currentRound < expRounds || !rounds[currentRound].delivery);
  const pendingIncreased = n(d.scanned)>n(prev?.delivery_scanned) || n(fb.pending)>n(prev?.freshbag_pending)
    || (!night && n(ret?.pending)>n(prev?.return_pending));
  const reopened = !!prev?.work_completed_at && (scanMoved || pendingIncreased || invalidOldCompletion);
  if (rounds[currentRound].completed && (scanMoved || pendingIncreased) && !advanced) {
    rounds[currentRound].completed=null; rounds[currentRound].detected=null; rounds[currentRound].method=null;
  }
  const roundHasDelivery = !!rounds[currentRound].delivery;
  const candidate = exactDone && roundHasDelivery && !advanced && !scanMoved && !pendingIncreased;
  const exactCandidate = candidate ? (prev?.exact_complete_candidate_at || now) : null;
  const previousPollMs = tsMs(prev?.last_seen_at);
  const exactConfirmed = candidate && !!prev?.exact_complete_candidate_at
    && tsMs(prev.exact_complete_candidate_at) >= tsMs(rounds[currentRound].delivery)
    && Number.isFinite(previousPollMs) && tsMs(now) > previousPollMs;
  if (currentRound < expRounds && roundHasDelivery && !rounds[currentRound].completed
      && (exactConfirmed || idleMinutes >= 30)) {
    rounds[currentRound].completed = exactConfirmed ? prev.exact_complete_candidate_at : kstIso(tsMs(lastProgressAt)+60000);
    rounds[currentRound].detected = now;
    rounds[currentRound].method = exactConfirmed ? 'round_exact_2poll' : 'idle_30m';
  }
  const finalRoundReady = currentRound >= expRounds && roundHasDelivery;
  const staleTailConfirmed = finalRoundReady && deliveryRemaining<=2 && returnRemaining<=2
    && freshbagRemaining<=2 && idleMinutes>=30;
  let workCompletedAt = reopened ? null : (prev?.work_completed_at || null);
  let completionMethod = reopened ? null : (prev?.completion_method || null);
  let completionDetectedAt = reopened ? null : (prev?.completion_detected_at || null);
  if (!reopened && !workCompletedAt && finalRoundReady && (exactConfirmed || staleTailConfirmed)) {
    workCompletedAt = exactConfirmed ? prev.exact_complete_candidate_at : kstIso(tsMs(lastProgressAt)+60000);
    completionMethod = exactConfirmed ? 'exact_2poll' : 'stale_tail_30m'; completionDetectedAt = now;
  }
  if (workCompletedAt) {
    rounds[currentRound].completed ||= workCompletedAt;
    rounds[currentRound].detected ||= completionDetectedAt;
    rounds[currentRound].method ||= completionMethod;
  }
  return {expRounds,currentRound,rounds,lastProgressAt,lastScanActivityAt,exactCandidate,
    workCompletedAt,completionMethod,completionDetectedAt,deliveryDone,returnDone,freshbagDone,
    totalRemaining,reopenedByScan:reopened};
}
