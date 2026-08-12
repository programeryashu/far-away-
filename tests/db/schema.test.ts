import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Store } from "../../server/db/store.js";
import fs from "node:fs";

const TEST_DB = "./data/test_schema.db";

describe("Database Schema", () => {
  beforeEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  afterEach(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
  });

  it("should run migrations successfully", () => {
    const store = new Store(TEST_DB);
    expect(fs.existsSync(TEST_DB)).toBe(true);
    store.close();
  });

  it("should be idempotent (run twice)", () => {
    const store1 = new Store(TEST_DB);
    store1.close();

    const store2 = new Store(TEST_DB);
    expect(fs.existsSync(TEST_DB)).toBe(true);
    store2.close();
  });
});
