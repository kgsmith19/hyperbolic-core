import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge class lists, resolving conflicting Tailwind utilities left-to-right. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
