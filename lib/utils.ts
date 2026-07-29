import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Shared class combiner used by the Aceternity component registry. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
