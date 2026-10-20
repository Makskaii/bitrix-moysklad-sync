export type ServiceModeName = 'on' | 'pause' | 'off' | 'unknown';

export interface ModeTransitionPoint {
  id: string;
  fromMode: string;
  toMode: string;
  transitionedAt: Date;
}

export interface ActiveWindowSegment {
  from: Date;
  through: Date;
}

export interface SkippedWindowInterval extends ActiveWindowSegment {
  mode: ServiceModeName;
  reason: string;
}

export function buildActiveWindowSegments(
  windowFrom: Date,
  windowThrough: Date,
  trackedFrom: Date | null,
  transitions: ModeTransitionPoint[],
): { segments: ActiveWindowSegment[]; skipped: SkippedWindowInterval[]; coveredFrom: Date | null } {
  if (windowThrough <= windowFrom || !trackedFrom) {
    return {
      segments: [],
      skipped: windowThrough > windowFrom ? [{
        from: windowFrom, through: windowThrough, mode: 'unknown', reason: 'Mode history is not available for this interval.',
      }] : [],
      coveredFrom: null,
    };
  }

  const coveredFrom = new Date(Math.max(windowFrom.getTime(), trackedFrom.getTime()));
  if (coveredFrom >= windowThrough) {
    return {
      segments: [],
      skipped: [{ from: windowFrom, through: windowThrough, mode: 'unknown', reason: 'Mode history does not cover this window.' }],
      coveredFrom: null,
    };
  }

  const skipped: SkippedWindowInterval[] = [];
  if (coveredFrom > windowFrom) skipped.push({
    from: windowFrom, through: coveredFrom, mode: 'unknown',
    reason: 'Legacy mode history before interval tracking is unknown; this slice was excluded.',
  });

  const ordered = transitions
    .filter((item) => item.transitionedAt <= windowThrough)
    .sort((a, b) => a.transitionedAt.getTime() - b.transitionedAt.getTime() || a.id.localeCompare(b.id));
  let mode: ServiceModeName = 'unknown';
  for (const item of ordered) {
    if (item.transitionedAt <= coveredFrom) mode = knownMode(item.toMode);
    else break;
  }

  const segments: ActiveWindowSegment[] = [];
  let cursor = coveredFrom;
  for (const item of ordered) {
    if (item.transitionedAt <= coveredFrom) continue;
    const boundary = new Date(Math.min(item.transitionedAt.getTime(), windowThrough.getTime()));
    const inclusiveEnd = new Date(boundary.getTime() - 1);
    appendInterval(mode, cursor, inclusiveEnd, segments, skipped);
    cursor = boundary;
    mode = knownMode(item.toMode);
    if (cursor >= windowThrough) break;
  }
  appendInterval(mode, cursor, windowThrough, segments, skipped);
  return { segments, skipped, coveredFrom };
}

function appendInterval(
  mode: ServiceModeName,
  from: Date,
  through: Date,
  segments: ActiveWindowSegment[],
  skipped: SkippedWindowInterval[],
) {
  if (through <= from) return;
  if (mode === 'on') segments.push({ from, through });
  else skipped.push({
    from, through, mode,
    reason: mode === 'off'
      ? 'OFF interval is intentionally excluded; missed OFF changes are not replayed.'
      : mode === 'pause'
        ? 'PAUSE interval is excluded from nightly discovery; accepted queued events resume separately.'
        : 'Mode interval is unknown and was conservatively excluded.',
  });
}

function knownMode(value: string): ServiceModeName {
  return value === 'on' || value === 'pause' || value === 'off' ? value : 'unknown';
}
