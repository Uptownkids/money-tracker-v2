/** Demo dataset isolation: the demo lives in its own Dexie database. */
import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import { MoneyTrackerDB, getDemoDb } from "../src/data/db.js";
import { createRepositories } from "../src/data/repositories/index.js";
import { loadDemoData, wipeDemoData, isDemoMode } from "../src/app/seed.js";
import { mkAccount } from "./helpers.js";

describe("demo database isolation", () => {
  afterEach(async () => {
    // Clear without closing: getDemoDb() is a shared singleton and
    // delete() would leave it in a closed state for the next test.
    await wipeDemoData().catch(() => {});
  });

  it("wiping the demo leaves the real DB untouched", async () => {
    const realDb = new MoneyTrackerDB(`real-${Date.now()}`);
    const realRepos = createRepositories(realDb);
    await realRepos.accounts.put(
      mkAccount({ id: "real-acct", name: "Real Checking" }),
    );

    await loadDemoData();
    const demoRepos = createRepositories(getDemoDb());
    expect(await demoRepos.accounts.count()).toBeGreaterThan(0);
    expect(await realRepos.accounts.count()).toBe(1);

    await wipeDemoData();

    expect(await demoRepos.accounts.count()).toBe(0);
    expect(await realRepos.accounts.count()).toBe(1);
    expect((await realRepos.accounts.getById("real-acct"))?.name).toBe(
      "Real Checking",
    );
    expect(isDemoMode()).toBe(false);
    await realDb.delete();
  });

  it("demo and real databases are different IndexedDB databases", async () => {
    await loadDemoData();
    const demoRepos = createRepositories(getDemoDb());
    const checking = await demoRepos.accounts.getById("acct-checking");
    expect(checking?.name).toBe("Checking");
    expect(isDemoMode()).toBe(true);
  });
});
