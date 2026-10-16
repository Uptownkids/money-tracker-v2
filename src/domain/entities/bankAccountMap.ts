/**
 * Remembers which app account a bank CSV belongs to, so Malike maps each
 * bank account once. The bankKey is a short user-chosen label
 * (e.g. "WF Checking"); the importer suggests it from the file name and
 * pre-selects the mapped app account on later imports.
 */
export interface BankAccountMap {
  id: string;
  bankKey: string;
  appAccountId: string;
  createdAt: string;
  updatedAt: string;
}
