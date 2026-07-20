import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("Pi 包清单使用带产品名的包根扩展入口", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(rootDir, "package.json"), "utf8"),
  ) as {
    files?: string[];
    pi?: { extensions?: string[] };
  };

  assert.deepEqual(packageJson.pi?.extensions, ["./pi-lark-hub.ts"]);
  assert.ok(packageJson.files?.includes("pi-lark-hub.ts"));

  const entry = await readFile(resolve(rootDir, "pi-lark-hub.ts"), "utf8");
  assert.match(entry, /export \{ default \} from "\.\/src\/index\.js";/);

  const extension = await import("../pi-lark-hub.js");
  assert.equal(typeof extension.default, "function");
});
