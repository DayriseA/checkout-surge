const PADDING_TWO = 2;

function padTwoDigits(value: number): string {
  return value.toString().padStart(PADDING_TWO, "0");
}

export function formatDashboardTime(value: string): string {
  const instant = new Date(value);
  const utcHours = instant.getUTCHours();
  const utcMinutes = instant.getUTCMinutes();
  const utcSeconds = instant.getUTCSeconds();
  const clockHours = utcHours % 12 === 0 ? 12 : utcHours % 12;
  const period = utcHours < 12 ? "AM" : "PM";

  return `${padTwoDigits(clockHours)}:${padTwoDigits(utcMinutes)}:${padTwoDigits(utcSeconds)} ${period} UTC`;
}
