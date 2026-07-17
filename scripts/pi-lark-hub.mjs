#!/usr/bin/env node
/**
 * pi-lark-hub 启动包装：优先 tsx 跑 TypeScript 源码。
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const entry = path.join(root, "src", "hub", "cli.ts");
const require = createRequire(import.meta.url);

function resolveTsxCli() {
	try {
		return require.resolve("tsx/cli");
	} catch {
		return null;
	}
}

const tsxCli = resolveTsxCli();
const args = process.argv.slice(2);

if (!tsxCli) {
	console.error(
		"[pi-lark-hub] 未找到运行时依赖 tsx。请在包根目录执行 npm install（tsx 为 dependencies），或: npx tsx src/hub/cli.ts",
	);
	process.exit(1);
}

const child = spawn(process.execPath, [tsxCli, entry, ...args], {
	stdio: "inherit",
	cwd: root,
	env: process.env,
});

child.on("exit", (code, signal) => {
	if (signal) {
		process.kill(process.pid, signal);
		return;
	}
	process.exit(code ?? 1);
});
