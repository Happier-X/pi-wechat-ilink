/**
 * Hub 配置合并与校验单测（不依赖 lark-cli / 磁盘真实路径）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
	assertValidHubConfig,
	createDefaultHubConfig,
	formatConfigSummary,
	loadHubConfig,
	saveHubOwnerBinding,
	validateHubConfig,
} from "./config.js";

describe("loadHubConfig", () => {
	it("默认 console 模式、空白名单、requireAllowlist=false", () => {
		const c = loadHubConfig({
			skipFile: true,
			fileContent: null,
			env: {},
			configPath: "/tmp/no-such-lark-hub.json",
		});
		assert.equal(c.feishu.mode, "console");
		assert.equal(c.feishu.as, "bot");
		assert.equal(c.host, "127.0.0.1");
		assert.equal(c.port, 8765);
		assert.deepEqual(c.allowedOpenIds, []);
		assert.equal(c.requireAllowlist, false);
	});

	it("配置文件覆盖 defaults", () => {
		const c = loadHubConfig({
			configPath: "/virtual/config.json",
			fileContent: JSON.stringify({
				port: 9001,
				allowedOpenIds: ["ou_aaa", "ou_bbb"],
				feishu: {
					mode: "console",
					userId: "ou_operator",
				},
				requireAllowlist: true,
			}),
			env: {},
		});
		assert.equal(c.port, 9001);
		assert.deepEqual(c.allowedOpenIds, ["ou_aaa", "ou_bbb"]);
		assert.equal(c.feishu.userId, "ou_operator");
		assert.equal(c.requireAllowlist, true);
	});

	it("环境变量覆盖文件", () => {
		const c = loadHubConfig({
			configPath: "/virtual/config.json",
			fileContent: JSON.stringify({
				port: 9001,
				feishu: { mode: "console", userId: "ou_file" },
				allowedOpenIds: ["ou_file_only"],
			}),
			env: {
				PI_LARK_HUB_PORT: "9123",
				PI_LARK_FEISHU_MODE: "console",
				PI_LARK_FEISHU_USER_ID: "ou_env",
				PI_LARK_ALLOWED_OPEN_IDS: "ou_x, ou_y",
			},
		});
		assert.equal(c.port, 9123);
		assert.equal(c.feishu.userId, "ou_env");
		assert.deepEqual(c.allowedOpenIds, ["ou_x", "ou_y"]);
	});

	it("mode=lark-cli 且未显式 requireAllowlist → 默认 true", () => {
		const c = loadHubConfig({
			skipFile: true,
			fileContent: null,
			env: {
				PI_LARK_FEISHU_MODE: "lark-cli",
				PI_LARK_FEISHU_USER_ID: "ou_op",
				PI_LARK_ALLOWED_OPEN_IDS: "ou_op",
			},
			configPath: "/tmp/x.json",
		});
		assert.equal(c.feishu.mode, "lark-cli");
		assert.equal(c.requireAllowlist, true);
	});

	it("可显式 requireAllowlist=false（紧急）", () => {
		const c = loadHubConfig({
			configPath: "/virtual/c.json",
			fileContent: JSON.stringify({
				feishu: { mode: "lark-cli", userId: "ou_1" },
				requireAllowlist: false,
			}),
			env: {},
		});
		assert.equal(c.requireAllowlist, false);
	});

	it("无效 mode 抛错", () => {
		assert.throws(
			() =>
				loadHubConfig({
					skipFile: true,
					env: { PI_LARK_FEISHU_MODE: "webhook" },
					configPath: "/tmp/x.json",
				}),
			/feishu\.mode/,
		);
	});
});

describe("validateHubConfig", () => {
	it("console 空白名单通过", () => {
		const c = createDefaultHubConfig();
		assert.deepEqual(validateHubConfig(c), []);
	});

	it("lark-cli 缺 userId/chatId → 错误", () => {
		const c = createDefaultHubConfig();
		c.feishu.mode = "lark-cli";
		c.allowedOpenIds = ["ou_1"];
		c.requireAllowlist = true;
		const errs = validateHubConfig(c);
		assert.ok(errs.some((e) => e.code === "missing_recipient"));
	});

	it("lark-cli 空白名单 → 允许 bootstrap（无 allowlist_required）", () => {
		const c = createDefaultHubConfig();
		c.feishu.mode = "lark-cli";
		c.allowedOpenIds = [];
		c.requireAllowlist = true;
		// 无 userId 亦可：bootstrap 配对
		const errs = validateHubConfig(c);
		assert.equal(
			errs.some((e) => e.code === "allowlist_required"),
			false,
		);
		assert.equal(
			errs.some((e) => e.code === "missing_recipient"),
			false,
		);
		assert.doesNotThrow(() => assertValidHubConfig(c));
	});

	it("lark-cli 有白名单但无收件人 → missing_recipient", () => {
		const c = createDefaultHubConfig();
		c.feishu.mode = "lark-cli";
		c.allowedOpenIds = ["ou_1"];
		c.requireAllowlist = true;
		const errs = validateHubConfig(c);
		assert.ok(errs.some((e) => e.code === "missing_recipient"));
	});

	it("saveHubOwnerBinding 写单主人并清 chatId", () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "lark-hub-pair-"));
		const configPath = path.join(dir, "config.json");
		try {
			const base = createDefaultHubConfig();
			base.feishu.mode = "lark-cli";
			base.feishu.chatId = "oc_old";
			base.configPath = configPath;
			const { config } = saveHubOwnerBinding({
				openId: "ou_owner_1",
				base,
				configPath,
			});
			assert.deepEqual(config.allowedOpenIds, ["ou_owner_1"]);
			assert.equal(config.feishu.userId, "ou_owner_1");
			assert.equal(config.feishu.chatId, undefined);
			assert.equal(config.feishu.mode, "lark-cli");
			const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
				allowedOpenIds: string[];
				feishu: { userId?: string; chatId?: string };
			};
			assert.deepEqual(raw.allowedOpenIds, ["ou_owner_1"]);
			assert.equal(raw.feishu.userId, "ou_owner_1");
			assert.equal(raw.feishu.chatId, undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("lark-cli 完整配置通过", () => {
		const c = createDefaultHubConfig();
		c.feishu.mode = "lark-cli";
		c.feishu.userId = "ou_op";
		c.allowedOpenIds = ["ou_op"];
		c.requireAllowlist = true;
		assert.deepEqual(validateHubConfig(c), []);
	});

	it("userId 与 chatId 同时存在 → 错误", () => {
		const c = createDefaultHubConfig();
		c.feishu.mode = "lark-cli";
		c.feishu.userId = "ou_1";
		c.feishu.chatId = "oc_1";
		c.allowedOpenIds = ["ou_1"];
		const errs = validateHubConfig(c);
		assert.ok(errs.some((e) => e.code === "ambiguous_recipient"));
	});
});

describe("formatConfigSummary", () => {
	it("脱敏 openId", () => {
		const c = createDefaultHubConfig();
		c.allowedOpenIds = ["ou_abcdef1234567890"];
		c.feishu.userId = "ou_operator_long_id_here";
		const s = formatConfigSummary(c);
		assert.match(s, /ou_abc…|ou_ope…/);
		assert.doesNotMatch(s, /ou_abcdef1234567890/);
	});
});
