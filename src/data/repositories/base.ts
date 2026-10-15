/** Generic entity repository; one typed repository per entity below. */
import type { Table } from "dexie";

export interface HasId {
  id: string;
}

export class Repository<T extends HasId> {
  protected table: Table<T, string>;

  constructor(table: Table<T, string>) {
    this.table = table;
  }

  getAll(): Promise<T[]> {
    return this.table.toArray();
  }

  getById(id: string): Promise<T | undefined> {
    return this.table.get(id);
  }

  put(entity: T): Promise<string> {
    return this.table.put(entity);
  }

  putMany(entities: T[]): Promise<void> {
    return this.table.bulkPut(entities).then(() => undefined);
  }

  remove(id: string): Promise<void> {
    return this.table.delete(id);
  }

  clear(): Promise<void> {
    return this.table.clear();
  }

  count(): Promise<number> {
    return this.table.count();
  }
}
