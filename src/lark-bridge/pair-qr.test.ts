import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	defaultPairQrPath,
	openPathBestEffort,
	pairQrPayload,
	writePairQrPng,
} from "./pair-qr.js";

describe("pairQrPayload", () => {
	it("统一大写码", () => {
		assert.equal(pairQrPayload("ab12cd"), "配对 AB12CD");
	});
});

describe("defaultPairQrPath", () => {
	it("落在 .pi/lark-hub", () => {
		const p = defaultPairQrPath("/home/u");
		assert.match(p.replace(/\\/g, "/"), /\/.pi\/lark-hub\/pair-qr\.png$/);
	});
});

describe("writePairQrPng", () => {
	it("成功写文件", async () => {
		let seen = "";
		let path = "";
		const r = await writePairQrPng("xy99zz", {
			outPath: "/tmp/pair-qr-test.png",
			toFile: async (filePath, text) => {
				path = filePath;
				seen = text;
			},
		});
		assert.equal(r.ok, true);
		assert.equal(path, "/tmp/pair-qr-test.png");
		assert.equal(seen, "配对 XY99ZZ");
		if (r.ok) assert.equal(r.payload, "配对 XY99ZZ");
	});

	it("toFile 失败降级", async () => {
		const r = await writePairQrPng("AA11BB", {
			outPath: "/tmp/x.png",
			toFile: async () => {
				throw new Error("disk full");
			},
		});
		assert.equal(r.ok, false);
		if (!r.ok) assert.match(r.error, /disk full/);
	});
});

describe("openPathBestEffort", () => {
	it("windows 使用 start", () => {
		const calls: Array<{ cmd: string; args: string[] }> = [];
		openPathBestEffort("C:\\a\\b.png", {
			platform: "win32",
			spawnFn: ((cmd: string, args: string[]) => {
				calls.push({ cmd, args });
				return { unref: () => {} } as ReturnType<typeof import("node:child_process").spawn>;
			}) as typeof import("node:child_process").spawn,
		});
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.cmd, "cmd");
		assert.deepEqual(calls[0]!.args, ["/c", "start", "", "C:\\a\\b.png"]);
	});
});
