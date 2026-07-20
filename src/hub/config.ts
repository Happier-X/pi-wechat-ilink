/**
 * Hub 配置：defaults < 配置文件 < 环境变量。
 * Hub 只支持飞书原生模式；未完成开局时不启动飞书运行时。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { replaceFileAtomic } from "./atomic-file.js";
import { DEFAULT_HUB_HOST, DEFAULT_HUB_PORT } from "./server.js";

export type FeishuMode = "native" | (string & {});
export type FeishuAs = "bot" | "user";

export type HubConfig = {
	host: "127.0.0.1";
	port: number;
	/** 唯一可信主人；未完成扫码开局时为空 */
	allowedOpenIds: string[];
	feishu: {
		mode: FeishuMode;
		as: FeishuAs;
		/** open_id（ou_xxx），与 chatId 二选一 */
		userId?: string;
		/** chat_id（oc_xxx），与 userId 二选一 */
		chatId?: string;
	};
	/** 完成开局后为 true；未配置状态允许 Hub 启动等待 `/lark` */
	requireAllowlist: boolean;
	/** 实际加载的配置文件路径（若有） */
	configPath?: string;
};

export type HubConfigFile = {
	host?: string;
	port?: number;
	allowedOpenIds?: string[];
	feishu?: {
		mode?: string;
		as?: string;
		userId?: string;
		chatId?: string;
	};
	requireAllowlist?: boolean;
};

export type LoadHubConfigOptions = {
	/** 覆盖配置文件路径；默认 ~/.pi/lark-hub/config.json 或 PI_LARK_HUB_CONFIG */
	configPath?: string;
	/** 注入 env（测试用）；默认 process.env */
	env?: NodeJS.ProcessEnv;
	/** 跳过读盘（测试用） */
	fileContent?: string | null;
	/** 跳过「文件是否存在」检查，配合 fileContent */
	skipFile?: boolean;
};

const DEFAULT_CONFIG_REL = path.join(".pi", "lark-hub", "config.json");

export function defaultConfigPath(home = os.homedir()): string {
	return path.join(home, DEFAULT_CONFIG_REL);
}

export function createDefaultHubConfig(): HubConfig {
	return {
		host: DEFAULT_HUB_HOST as "127.0.0.1",
		port: DEFAULT_HUB_PORT,
		allowedOpenIds: [],
		feishu: {
			mode: "native",
			as: "bot",
		},
		requireAllowlist: false,
	};
}

function parseOpenIdList(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	return raw
		.split(/[,;\s]+/)
		.map((s) => s.trim())
		.filter(Boolean);
}

function parseMode(raw: string | undefined): FeishuMode | undefined {
	if (raw === undefined || raw === "") return undefined;
	const v = raw.trim().toLowerCase();
	if (v === "native") return v;
	throw new Error(`无效 feishu.mode: ${raw}（只允许 native）`);
}

function parseAs(raw: string | undefined): FeishuAs | undefined {
	if (raw === undefined || raw === "") return undefined;
	const v = raw.trim().toLowerCase();
	if (v === "bot" || v === "user") return v;
	throw new Error(`无效 feishu.as: ${raw}（允许 bot | user）`);
}

function parsePort(raw: string | number | undefined): number | undefined {
	if (raw === undefined || raw === "") return undefined;
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n) || n <= 0 || n > 65535) {
		throw new Error(`无效端口: ${raw}`);
	}
	return Math.floor(n);
}

function readConfigFile(
	configPath: string,
	options: LoadHubConfigOptions,
): HubConfigFile | null {
	if (options.skipFile) {
		if (options.fileContent === null || options.fileContent === undefined) {
			return null;
		}
		return JSON.parse(options.fileContent) as HubConfigFile;
	}
	if (options.fileContent !== undefined) {
		if (options.fileContent === null) return null;
		return JSON.parse(options.fileContent) as HubConfigFile;
	}
	if (!existsSync(configPath)) return null;
	const text = readFileSync(configPath, "utf8");
	if (!text.trim()) return null;
	return JSON.parse(text) as HubConfigFile;
}

/**
 * 合并顺序：defaults < 配置文件 < 环境变量。
 * 旧模式值会被拒绝，仅接受 native。
 */
export function loadHubConfig(options: LoadHubConfigOptions = {}): HubConfig {
	const env = options.env ?? process.env;
	const envConfigPath = env.PI_LARK_HUB_CONFIG?.trim() || undefined;
	const configPath =
		options.configPath ?? envConfigPath ?? defaultConfigPath();

	const base = createDefaultHubConfig();
	let fromFile: HubConfigFile | null = null;
	try {
		fromFile = readConfigFile(configPath, options);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		throw new Error(`读取配置失败 ${configPath}: ${msg}`);
	}

	const merged: HubConfig = {
		...base,
		feishu: { ...base.feishu },
		configPath: fromFile ? configPath : options.configPath ?? envConfigPath,
	};

	if (fromFile) {
		const filePort = parsePort(fromFile.port);
		if (filePort !== undefined) merged.port = filePort;
		if (Array.isArray(fromFile.allowedOpenIds)) {
			merged.allowedOpenIds = fromFile.allowedOpenIds
				.map((s) => String(s).trim())
				.filter(Boolean);
		}
		if (typeof fromFile.requireAllowlist === "boolean") {
			merged.requireAllowlist = fromFile.requireAllowlist;
		}
		if (fromFile.feishu) {
			const mode = parseMode(fromFile.feishu.mode);
			if (mode) merged.feishu.mode = mode;
			const as = parseAs(fromFile.feishu.as);
			if (as) merged.feishu.as = as;
			if (fromFile.feishu.userId !== undefined) {
				const u = String(fromFile.feishu.userId).trim();
				merged.feishu.userId = u || undefined;
			}
			if (fromFile.feishu.chatId !== undefined) {
				const c = String(fromFile.feishu.chatId).trim();
				merged.feishu.chatId = c || undefined;
			}
		}
		// 文件存在时记录路径
		merged.configPath = configPath;
	}

	// 环境变量覆盖
	const envPort = parsePort(env.PI_LARK_HUB_PORT);
	if (envPort !== undefined) merged.port = envPort;

	const envIds = parseOpenIdList(env.PI_LARK_ALLOWED_OPEN_IDS);
	if (envIds !== undefined) merged.allowedOpenIds = envIds;

	const envMode = parseMode(env.PI_LARK_FEISHU_MODE);
	if (envMode) merged.feishu.mode = envMode;

	if (env.PI_LARK_FEISHU_USER_ID !== undefined) {
		const u = env.PI_LARK_FEISHU_USER_ID.trim();
		merged.feishu.userId = u || undefined;
	}
	if (env.PI_LARK_FEISHU_CHAT_ID !== undefined) {
		const c = env.PI_LARK_FEISHU_CHAT_ID.trim();
		merged.feishu.chatId = c || undefined;
	}

	if (env.PI_LARK_REQUIRE_ALLOWLIST !== undefined) {
		const v = env.PI_LARK_REQUIRE_ALLOWLIST.trim().toLowerCase();
		if (v === "1" || v === "true" || v === "yes") merged.requireAllowlist = true;
		else if (v === "0" || v === "false" || v === "no") merged.requireAllowlist = false;
	}

	// host 永远 loopback
	merged.host = "127.0.0.1";

	return merged;
}

export type ConfigValidationError = {
	code: string;
	message: string;
};

/**
 * 校验配置；返回错误列表（空=通过）。
 * 调用方可 throw 首条或全部。
 */
export function validateHubConfig(config: HubConfig): ConfigValidationError[] {
	const errors: ConfigValidationError[] = [];

	if (config.host !== "127.0.0.1" && config.host !== "localhost") {
		errors.push({
			code: "host_not_loopback",
			message: `Hub 仅允许监听 127.0.0.1，收到 host=${config.host}`,
		});
	}

	if (!Number.isFinite(config.port) || config.port <= 0 || config.port > 65535) {
		errors.push({
			code: "invalid_port",
			message: `无效端口: ${config.port}`,
		});
	}

	if (config.feishu.mode !== "native") errors.push({ code: "invalid_mode", message: `无效 feishu.mode: ${config.feishu.mode}` });
	const hasUser = Boolean(config.feishu.userId?.trim());
	const hasChat = Boolean(config.feishu.chatId?.trim());
	if (hasChat) errors.push({ code: "chat_recipient_removed", message: "只支持唯一主人私聊，不再支持 feishu.chatId" });
	if (config.allowedOpenIds.length > 0 && !hasUser) errors.push({ code: "missing_recipient", message: "已配置主人时必须设置 feishu.userId" });
	if (config.allowedOpenIds.length > 1) errors.push({ code: "multiple_owners", message: "只支持唯一主人" });
	if (config.requireAllowlist && config.allowedOpenIds.length === 0) errors.push({ code: "allowlist_required", message: "requireAllowlist=true 但 allowedOpenIds 为空" });

	return errors;
}

/**
 * 将唯一主人 open_id 写入配置文件（本人 DM，清除 chatId）。
 * 路径：options.configPath ?? config.configPath ?? defaultConfigPath()
 */
export function saveHubOwnerBinding(input: {
	openId: string;
	configPath?: string;
	/** 当前内存配置，用于合并 mode/as/port 等 */
	base?: HubConfig;
}): { configPath: string; config: HubConfig } {
	const openId = input.openId.trim();
	if (!openId) throw new Error("openId 不能为空");

	const configPath =
		input.configPath?.trim() ||
		input.base?.configPath?.trim() ||
		defaultConfigPath();

	let existing: HubConfigFile = {};
	if (existsSync(configPath)) {
		try {
			const raw = JSON.parse(readFileSync(configPath, "utf8")) as HubConfigFile;
			if (raw && typeof raw === "object") existing = raw;
		} catch {
			existing = {};
		}
	}

	const mode =
		(typeof existing.feishu?.mode === "string"
			? existing.feishu.mode
			: input.base?.feishu.mode) ?? "native";
	const as =
		(typeof existing.feishu?.as === "string"
			? existing.feishu.as
			: input.base?.feishu.as) ?? "bot";

	const nextFile: HubConfigFile = {
		...existing,
		allowedOpenIds: [openId],
		requireAllowlist: true,
		feishu: {
			...(existing.feishu ?? {}),
			mode,
			as,
			userId: openId,
		},
	};
	delete nextFile.feishu!.chatId;

	mkdirSync(path.dirname(configPath), { recursive: true });
	writeConfigFileAtomic(configPath, nextFile);

	const config = loadHubConfig({
		configPath,
		skipFile: false,
		env: {}, // 落盘结果以文件为准，避免测试 env 干扰
	});
	return { configPath, config };
}

/** setup 成功后原子写 native mode 与唯一可信主人。 */
export function saveNativeSetupConfig(input: {
	configPath?: string;
	base?: HubConfig;
	ownerOpenId?: string;
}): { configPath: string; config: HubConfig } {
	const configPath = input.configPath?.trim() || input.base?.configPath?.trim() || defaultConfigPath();
	let existing: HubConfigFile = {};
	if (existsSync(configPath)) {
		try { existing = JSON.parse(readFileSync(configPath, "utf8")) as HubConfigFile; } catch { existing = {}; }
	}
	const owner = input.ownerOpenId?.trim();
	if (!owner) throw new Error("可信主人 open_id 不能为空");
	const nextFile: HubConfigFile = {
		...existing,
		allowedOpenIds: [owner],
		requireAllowlist: true,
		feishu: {
			...(existing.feishu ?? {}),
			mode: "native",
			as: (existing.feishu?.as ?? input.base?.feishu.as ?? "bot"),
		},
	};
	nextFile.feishu!.userId = owner;
	delete nextFile.feishu!.chatId;
	writeConfigFileAtomic(configPath, nextFile);
	return { configPath, config: loadHubConfig({ configPath, skipFile: false, env: {} }) };
}

/** reset：删除飞书运行配置与主人绑定，保留 host/port 等 Hub 配置。 */
export function resetNativeConfig(input: { configPath?: string; base?: HubConfig } = {}): string {
	const configPath = input.configPath?.trim() || input.base?.configPath?.trim() || defaultConfigPath();
	let existing: HubConfigFile = {};
	if (existsSync(configPath)) { try { existing = JSON.parse(readFileSync(configPath, "utf8")) as HubConfigFile; } catch { existing = {}; } }
	delete existing.feishu;
	delete existing.allowedOpenIds;
	delete existing.requireAllowlist;
	writeConfigFileAtomic(configPath, existing);
	return configPath;
}

function writeConfigFileAtomic(configPath: string, value: HubConfigFile): void {
	mkdirSync(path.dirname(configPath), { recursive: true });
	const tmp = `${configPath}.${process.pid}.${Date.now()}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	replaceFileAtomic(tmp, configPath);
}

export function assertValidHubConfig(config: HubConfig): void {
	const errors = validateHubConfig(config);
	if (errors.length > 0) {
		throw new Error(errors.map((e) => e.message).join("\n"));
	}
}

/** 启动日志用：脱敏摘要（不打印完整 openId 列表细节过多时截断） */
export function formatConfigSummary(config: HubConfig): string {
	const ids = config.allowedOpenIds;
	const idSummary =
		ids.length === 0
			? "（空）"
			: ids.length <= 3
				? ids.map(redactOpenId).join(", ")
				: `${ids.slice(0, 2).map(redactOpenId).join(", ")} …共 ${ids.length} 个`;

	const recipient = config.feishu.userId
		? `userId=${redactOpenId(config.feishu.userId)}`
		: config.feishu.chatId
			? `chatId=${redactChatId(config.feishu.chatId)}`
			: "（未设）";

	const lines = [
		`host=${config.host} port=${config.port}`,
		`feishu.mode=${config.feishu.mode} as=${config.feishu.as} ${recipient}`,
		`allowedOpenIds=${idSummary}`,
		`requireAllowlist=${config.requireAllowlist}`,
		config.configPath ? `configPath=${config.configPath}` : "configPath=（默认/无文件）",
	];
	return lines.join("\n");
}

function redactOpenId(id: string): string {
	if (id.length <= 10) return `${id.slice(0, 4)}…`;
	return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

function redactChatId(id: string): string {
	if (id.length <= 10) return `${id.slice(0, 4)}…`;
	return `${id.slice(0, 6)}…${id.slice(-4)}`;
}
