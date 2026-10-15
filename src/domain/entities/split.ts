import type { DateOnly } from "../dates/dateOnly.js";
import type { MinorUnits } from "../money/money.js";

export type IouDirection = "TheyOweMe" | "IOweThem";

export interface Split {
  id: string;
  linkedTransactionId: string; // the expense this came from
  person: string;
  amount: MinorUnits;
  currency: string;
  direction: IouDirection;
  settled: boolean;
  countOnIt: boolean; // default false; only counted in safe-to-spend
  // if true AND due before next payday
  expectedBy?: DateOnly;
  createdAt: string;
  settledAt?: string;
}
