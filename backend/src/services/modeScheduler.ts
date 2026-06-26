import { prisma } from '../index';

let schedulerInterval: NodeJS.Timeout | null = null;

/**
 * Get current time in HH:MM format for a given timezone
 */
function getCurrentTimeInTimezone(timezone: string): string {
  try {
    return new Date().toLocaleTimeString('en-US', {
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });
  } catch {
    // Fallback to New York if invalid timezone
    return new Date().toLocaleTimeString('en-US', {
      timeZone: 'America/New_York',
      hour12: false,
      hour: '2-digit',
      minute: '2-digit'
    });
  }
}

/**
 * Get current day of week (0-6, Sunday-Saturday) for a given timezone
 */
function getCurrentDayInTimezone(timezone: string): number {
  try {
    const dayStr = new Date().toLocaleString('en-US', {
      timeZone: timezone,
      weekday: 'short'
    });
    return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayStr);
  } catch {
    return new Date().getDay();
  }
}

/**
 * Check if current time falls within a schedule's time range
 */
function isTimeInRange(currentTime: string, startTime: string, endTime: string): boolean {
  // Handle overnight schedules (e.g., 22:00 - 06:00)
  if (endTime < startTime) {
    // Time is in range if it's after start OR before end
    return currentTime >= startTime || currentTime < endTime;
  }
  // Normal schedule (e.g., 09:30 - 16:00)
  return currentTime >= startTime && currentTime < endTime;
}

// Re-evaluated on every call — no caching so day transitions are always correct
function isWeekendET(): boolean {
  const day = new Date().toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  });
  return day === 'Sat' || day === 'Sun';
}

// Caches a confirmed-disabled use_time_schedules flag for a few minutes so
// the 60s tick doesn't hit the DB every single minute for users who don't
// use time-based mode scheduling at all (the common case). Only the
// "disabled" state is cached - once schedules are active we recheck live
// every tick so mode changes still land within a minute as intended.
let scheduleDisabledUntil = 0;

/**
 * Check schedules and update execution mode if needed
 */
async function checkAndUpdateMode() {
  // Skip on weekends — no schedules apply, avoids unnecessary DB query
  if (isWeekendET()) return;

  if (Date.now() < scheduleDisabledUntil) return;

  try {
    const settings = await prisma.executionSettings.findFirst();

    // Skip if time schedules are disabled
    if (!settings?.use_time_schedules) {
      scheduleDisabledUntil = Date.now() + 5 * 60 * 1000;
      return;
    }

    const timezone = settings.timezone || 'America/New_York';
    const currentTime = getCurrentTimeInTimezone(timezone);
    const dayOfWeek = getCurrentDayInTimezone(timezone);

    // Get all enabled schedules, ordered by priority (highest first)
    const schedules = await prisma.executionSchedule.findMany({
      where: { enabled: true },
      orderBy: { priority: 'desc' }
    });

    // Find the first matching schedule
    let targetMode = 'off'; // Default when no schedule matches
    let matchedSchedule: string | null = null;

    for (const schedule of schedules) {
      // Parse days_of_week (e.g., "1,2,3,4,5" for weekdays)
      const days = schedule.days_of_week.split(',').map(d => parseInt(d.trim()));

      // Skip if current day not in schedule
      if (!days.includes(dayOfWeek)) {
        continue;
      }

      // Check if current time is within schedule range
      if (isTimeInRange(currentTime, schedule.start_time, schedule.end_time)) {
        targetMode = schedule.execution_mode;
        matchedSchedule = schedule.name;
        break; // Use first matching schedule (highest priority)
      }
    }

    // Update mode if it changed
    if (settings.execution_mode !== targetMode) {
      await prisma.executionSettings.update({
        where: { id: settings.id },
        data: { execution_mode: targetMode }
      });

      // Create audit log entry
      await prisma.auditLog.create({
        data: {
          event_type: 'mode_auto_changed',
          ticker: null,
          details: JSON.stringify({
            from: settings.execution_mode,
            to: targetMode,
            schedule: matchedSchedule,
            time: currentTime,
            day: dayOfWeek,
            timezone: timezone
          })
        }
      });

      console.log(`⏰ Auto-switched mode: ${settings.execution_mode} → ${targetMode}${matchedSchedule ? ` (${matchedSchedule})` : ''}`);
    }
  } catch (error) {
    console.error('❌ Mode scheduler error:', error);
  }
}

/**
 * Start the mode scheduler (checks every minute)
 */
export function startModeScheduler() {
  console.log('⏰ Starting mode scheduler (checks every minute)');

  // Run immediately on startup
  checkAndUpdateMode();

  // Then run every minute
  schedulerInterval = setInterval(checkAndUpdateMode, 60 * 1000);
}

/**
 * Stop the mode scheduler
 */
export function stopModeScheduler() {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('⏰ Mode scheduler stopped');
  }
}

/**
 * Manually trigger a mode check (useful for testing)
 */
export async function triggerModeCheck() {
  await checkAndUpdateMode();
}
