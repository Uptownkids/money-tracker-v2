/** One CSV import batch. Rolling back deletes every transaction the batch created. */
export type ImportBatchStatus = "committed" | "rolled-back";

export interface ImportBatch {
  id: string;
  createdAt: string;
  /** Source file names, in the order they were added. */
  fileNames: string[];
  stats: {
    rows: number;
    imported: number;
    duplicates: number;
  };
  status: ImportBatchStatus;
}
