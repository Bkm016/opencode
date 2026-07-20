import { DateTime } from "luxon"

export function createSessionContextFormatter(locale: string) {
  return {
    number(value: number | null | undefined) {
      if (value === undefined) return "—"
      if (value === null) return "—"
      return value.toLocaleString(locale)
    },
    percent(value: number | null | undefined) {
      if (value === undefined) return "—"
      if (value === null) return "—"
      return value.toLocaleString(locale) + "%"
    },
    bytes(value: number | null | undefined) {
      if (value === undefined) return "—"
      if (value === null) return "—"
      if (value < 1024) return value.toLocaleString(locale) + " B"
      const units = ["KB", "MB", "GB"] as const
      const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)) - 1, units.length - 1)
      const size = value / 1024 ** (unit + 1)
      const digits = size >= 100 ? 0 : size >= 10 ? 1 : 2
      return `${size.toLocaleString(locale, { maximumFractionDigits: digits, minimumFractionDigits: 0 })} ${units[unit]}`
    },
    time(value: number | undefined) {
      if (!value) return "—"
      return DateTime.fromMillis(value).setLocale(locale).toLocaleString(DateTime.DATETIME_MED)
    },
  }
}
