#!/usr/bin/env node

import type { createInterface } from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "fs";

const AUTH_FILE = "auth.json";

function _prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
	return new Promise((resolve) => rl.question(question, resolve));
}

function getAuthPath(): string {
	return join(homedir(), ".pi", "agent", AUTH_FILE);
}

import { homedir } from "os";
import { join } from "path";

function loadAuth(): Record<string, { type: "oauth"; access: string }> {
	if (!existsSync(getAuthPath())) return {};
	return JSON.parse(readFileSync(getAuthPath(), "utf-8"));
}

function _saveAuth(auth: Record<string, unknown>): void {
	writeFileSync(getAuthPath(), `${JSON.stringify(auth, null, 2)}\n`);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args[0];

	if (command === "list") {
		const auth = loadAuth();
		for (const [provider, cred] of Object.entries(auth)) {
			console.log(`  ${provider.padEnd(20)} ${cred.access.substring(0, 10)}...`);
		}
		return;
	}

	if (command === "get") {
		const auth = loadAuth();
		const entry = auth[args[1]];
		if (entry) {
			console.log(entry.access);
		}
		return;
	}

	// Interactive mode
	if (command !== "login") {
		console.log("Usage: pi-ai <command> [args]");
		console.log("");
		console.log("Commands:");
		console.log("  list        List all stored credentials");
		console.log("  get <id>    Get access token for a provider");
		return;
	}
}

main().catch(console.error);
