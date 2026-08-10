import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

// Shared by every mutation's onError across the pages — an Error gets its
// message, anything else gets stringified as-is.
export function errMsg(e: unknown): string {
  return String(e instanceof Error ? e.message : e)
}
