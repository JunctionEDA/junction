// limits.ts — what one run of a custom feature's script may use (script/sandbox.ts enforces them).  Pure: the
// page reads these to say how much of its allowance a script used.
export interface Limits {
  /** interrupt-handler calls allowed (the interpreter calls it about every 10 000 operations) */
  ticks: number;
  /** wall-clock allowance, kernel work included */
  ms: number;
  /** the interpreter's memory, bytes */
  memory: number;
  /** calls to the host */
  calls: number;
}
export const RUN_LIMITS: Limits = { ticks: 60000, ms: 30000, memory: 64 << 20, calls: 50000 };
export const DESCRIBE_LIMITS: Limits = { ticks: 2000, ms: 2000, memory: 32 << 20, calls: 0 };
