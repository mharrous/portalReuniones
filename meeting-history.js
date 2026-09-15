export const MEETING_HISTORY_LIMIT = 5;

function completedTimestamp(meeting) {
  const timestamp = Date.parse(String(meeting.completed_at || ""));
  return Number.isFinite(timestamp) ? timestamp : 0;
}

export function mergeRecentMeetingHistory(
  existingHistory = [],
  completedMeetings = [],
  limit = MEETING_HISTORY_LIMIT,
) {
  const mergedById = new Map();

  for (const meeting of [...existingHistory, ...completedMeetings]) {
    const id = String(meeting?.id || "").trim();
    if (!id) continue;
    mergedById.set(id, { ...meeting, id });
  }

  return [...mergedById.values()]
    .sort((left, right) => completedTimestamp(right) - completedTimestamp(left))
    .slice(0, Math.max(0, Number(limit) || 0));
}
