const DEFAULT_CRON_TIME_ZONE = "America/Chicago";

export function getCronTimeZone(): string {
  return process.env.CRON_TIME_ZONE?.trim() || DEFAULT_CRON_TIME_ZONE;
}

export function getWeekdayInCronTimeZone(date = new Date()): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: getCronTimeZone(),
    weekday: "short",
  }).format(date);
}

export function isWeekdayInCronTimeZone(
  weekday: "Thu" | "Fri",
  date = new Date(),
): boolean {
  return getWeekdayInCronTimeZone(date) === weekday;
}
