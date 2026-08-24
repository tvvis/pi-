import { describe, expect, it } from "vitest";
import { checkCommandRestrictions, RESTRICTED_PROVIDERS } from "../src/core/tools/command-restrictions.ts";
import { BashCommandRestrictedError, createBashTool } from "../src/core/tools/index.ts";

const RESTRICTED = "minimax-cn";

describe("command-restrictions", () => {
	describe("checkCommandRestrictions", () => {
		it("returns undefined for unknown providers", () => {
			expect(checkCommandRestrictions("rm -rf /", "anthropic")).toBeUndefined();
			expect(checkCommandRestrictions("git status", "openai")).toBeUndefined();
		});

		it("returns undefined when provider is missing", () => {
			expect(checkCommandRestrictions("rm -rf /", undefined)).toBeUndefined();
		});

		it("blocks rm with -rf flag", () => {
			const violation = checkCommandRestrictions("rm -rf /tmp/foo", RESTRICTED);
			expect(violation?.reason).toMatch(/recursive and force/);
		});

		it("blocks rm with reordered -fr / -Rf / -fR flag combinations", () => {
			expect(checkCommandRestrictions("rm -fr /tmp/foo", RESTRICTED)?.reason).toMatch(/recursive and force/);
			expect(checkCommandRestrictions("rm -Rf /tmp/foo", RESTRICTED)?.reason).toMatch(/recursive and force/);
			expect(checkCommandRestrictions("rm -fR /tmp/foo", RESTRICTED)?.reason).toMatch(/recursive and force/);
			expect(checkCommandRestrictions("rm -vrf /tmp/foo", RESTRICTED)?.reason).toMatch(/recursive and force/);
		});

		it("allows rm without recursive force combination", () => {
			expect(checkCommandRestrictions("rm /tmp/foo", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("rm -r /tmp/foo", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("rm -f /tmp/foo", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("rm -v /tmp/foo", RESTRICTED)).toBeUndefined();
		});

		it("allows rm --recursive --force (long flags, not -rf)", () => {
			// The request only forbids the short -rf combo. Long flags are out of scope.
			expect(checkCommandRestrictions("rm --recursive --force /tmp/foo", RESTRICTED)).toBeUndefined();
		});

		it("blocks git commands that mutate state", () => {
			expect(checkCommandRestrictions("git push", RESTRICTED)?.reason).toMatch(/git push/);
			expect(checkCommandRestrictions("git checkout main", RESTRICTED)?.reason).toMatch(/git checkout/);
			expect(checkCommandRestrictions("git reset --hard", RESTRICTED)?.reason).toMatch(/git reset/);
			expect(checkCommandRestrictions("git pull", RESTRICTED)?.reason).toMatch(/git pull/);
			expect(checkCommandRestrictions("git rebase main", RESTRICTED)?.reason).toMatch(/git rebase/);
			expect(checkCommandRestrictions("git merge feature", RESTRICTED)?.reason).toMatch(/git merge/);
			expect(checkCommandRestrictions("git cherry-pick HEAD", RESTRICTED)?.reason).toMatch(/git cherry-pick/);
			expect(checkCommandRestrictions("git stash", RESTRICTED)?.reason).toMatch(/git stash/);
			expect(checkCommandRestrictions("git clean -fd", RESTRICTED)?.reason).toMatch(/git clean/);
		});

		it("blocks mutating flag combinations for branch and tag", () => {
			expect(checkCommandRestrictions("git branch -d foo", RESTRICTED)?.reason).toMatch(/mutating flags/);
			expect(checkCommandRestrictions("git branch -D foo", RESTRICTED)?.reason).toMatch(/mutating flags/);
			expect(checkCommandRestrictions("git branch --delete foo", RESTRICTED)?.reason).toMatch(/mutating flags/);
			expect(checkCommandRestrictions("git branch -m new", RESTRICTED)?.reason).toMatch(/mutating flags/);
			expect(checkCommandRestrictions("git branch --move new", RESTRICTED)?.reason).toMatch(/mutating flags/);
			expect(checkCommandRestrictions("git tag -d v1", RESTRICTED)?.reason).toMatch(/mutating flags/);
			expect(checkCommandRestrictions("git tag --delete v1", RESTRICTED)?.reason).toMatch(/mutating flags/);
			expect(checkCommandRestrictions("git tag -f v1 msg", RESTRICTED)?.reason).toMatch(/mutating flags/);
		});

		it("allows read-only forms of branch and tag", () => {
			expect(checkCommandRestrictions("git branch", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git branch -a", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git branch -r", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git branch --list", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git branch --list 'feat*'", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git tag", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git tag -l", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git tag --list 'v*'", RESTRICTED)).toBeUndefined();
		});

		it("allows all read-only git subcommands", () => {
			for (const sub of [
				"branch",
				"cat-file",
				"describe",
				"diff",
				"diff-files",
				"diff-index",
				"diff-tree",
				"fetch",
				"format-patch",
				"grep",
				"help",
				"log",
				"ls-files",
				"ls-remote",
				"ls-tree",
				"reflog",
				"remote",
				"rev-list",
				"rev-parse",
				"shortlog",
				"show",
				"show-branch",
				"status",
				"tag",
				"version",
				"whatchanged",
			]) {
				expect(checkCommandRestrictions(`git ${sub}`, RESTRICTED)).toBeUndefined();
				expect(checkCommandRestrictions(`git ${sub} --some-flag arg`, RESTRICTED)).toBeUndefined();
			}
		});

		it("allows git add for staging", () => {
			expect(checkCommandRestrictions("git add foo", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git add .", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git add -A", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git add --all", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git add -p", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git add --patch", RESTRICTED)).toBeUndefined();
		});

		it("allows git fetch and git remote", () => {
			expect(checkCommandRestrictions("git fetch", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git fetch origin", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git fetch --all", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git fetch origin main", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git remote -v", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git remote show origin", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git remote get-url origin", RESTRICTED)).toBeUndefined();
		});

		it("allows git commit", () => {
			expect(checkCommandRestrictions("git commit -m 'msg'", RESTRICTED)).toBeUndefined();
			expect(checkCommandRestrictions("git commit --amend", RESTRICTED)).toBeUndefined();
		});

		it("inspects each segment of a chained command", () => {
			expect(checkCommandRestrictions("ls -la && rm -rf /tmp/foo", RESTRICTED)?.reason).toMatch(
				/recursive and force/,
			);
			expect(checkCommandRestrictions("git push; echo done", RESTRICTED)?.reason).toMatch(/git push/);
			expect(checkCommandRestrictions("echo hello | rm -rf /", RESTRICTED)?.reason).toMatch(/recursive and force/);
			expect(checkCommandRestrictions("echo hello", RESTRICTED)).toBeUndefined();
		});

		it("inspects background and subshell forms", () => {
			expect(checkCommandRestrictions("git push &", RESTRICTED)?.reason).toMatch(/git push/);
			expect(checkCommandRestrictions("$(rm -rf /)", RESTRICTED)?.reason).toMatch(/recursive and force/);
		});

		it("does not flag unrelated commands that contain the substring 'rm'", () => {
			expect(checkCommandRestrictions("echo 'rm -rf is dangerous'", RESTRICTED)).toBeUndefined();
		});

		it("treats bare `git` (no subcommand) as forbidden", () => {
			expect(checkCommandRestrictions("git", RESTRICTED)?.reason).toMatch(/git is not allowed/);
		});

		it("exposes the restricted provider list", () => {
			expect(RESTRICTED_PROVIDERS.has("minimax-cn")).toBe(true);
		});
	});

	describe("bash tool integration", () => {
		it("throws BashCommandRestrictedError for restricted providers", async () => {
			let invoked = false;
			const bash = createBashTool(process.cwd(), {
				operations: {
					exec: async () => {
						invoked = true;
						return { exitCode: 0 };
					},
				},
				getModel: () =>
					({
						provider: RESTRICTED,
						id: "MiniMax-M2",
						name: "MiniMax-M2",
						api: "anthropic-messages",
						baseUrl: "",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 0,
						maxTokens: 0,
					}) as any,
			});

			await expect(bash.execute("call-1", { command: "rm -rf /tmp/foo" })).rejects.toBeInstanceOf(
				BashCommandRestrictedError,
			);
			await expect(bash.execute("call-2", { command: "git push" })).rejects.toBeInstanceOf(
				BashCommandRestrictedError,
			);
			expect(invoked).toBe(false);
		});

		it("error message instructs the model to stop and wait for user intervention", async () => {
			const bash = createBashTool(process.cwd(), {
				operations: { exec: async () => ({ exitCode: 0 }) },
				getModel: () => ({ provider: RESTRICTED }) as any,
			});

			let error: unknown;
			try {
				await bash.execute("call-stop-1", { command: "rm -rf /tmp/foo" });
			} catch (err) {
				error = err;
			}
			expect(error).toBeInstanceOf(BashCommandRestrictedError);
			const message = (error as Error).message;
			expect(message).toMatch(/STOP/);
			expect(message).toMatch(/Do NOT retry/);
			expect(message).toMatch(/wait for the user/);
		});

		it("invokes onCommandRestricted callback before throwing", async () => {
			const calls: Array<{ command: string; reason: string }> = [];
			const bash = createBashTool(process.cwd(), {
				operations: { exec: async () => ({ exitCode: 0 }) },
				getModel: () => ({ provider: RESTRICTED }) as any,
				onCommandRestricted: (info) => calls.push(info),
			});

			await expect(bash.execute("call-cb-1", { command: "rm -rf /tmp/foo" })).rejects.toBeInstanceOf(
				BashCommandRestrictedError,
			);
			await expect(bash.execute("call-cb-2", { command: "git push" })).rejects.toBeInstanceOf(
				BashCommandRestrictedError,
			);
			expect(calls).toEqual([
				{ command: "rm -rf /tmp/foo", reason: expect.stringMatching(/recursive and force/) },
				{ command: "git push", reason: expect.stringMatching(/git push/) },
			]);
		});

		it("does not invoke onCommandRestricted for allowed commands", async () => {
			const calls: unknown[] = [];
			const bash = createBashTool(process.cwd(), {
				operations: { exec: async () => ({ exitCode: 0 }) },
				getModel: () => ({ provider: RESTRICTED }) as any,
				onCommandRestricted: (info) => calls.push(info),
			});

			await bash.execute("call-cb-3", { command: "git commit -m 'msg'" });
			await bash.execute("call-cb-4", { command: "git status" });
			await bash.execute("call-cb-5", { command: "git log --oneline" });
			await bash.execute("call-cb-6", { command: "git diff HEAD" });
			await bash.execute("call-cb-7", { command: "git show HEAD" });
			await bash.execute("call-cb-8", { command: "rm /tmp/foo" });
			expect(calls).toEqual([]);
		});

		it("allows restricted-provider commands that comply with the policy", async () => {
			let invokedCount = 0;
			const bash = createBashTool(process.cwd(), {
				operations: {
					exec: async () => {
						invokedCount++;
						return { exitCode: 0 };
					},
				},
				getModel: () =>
					({
						provider: RESTRICTED,
						id: "MiniMax-M2",
						name: "MiniMax-M2",
						api: "anthropic-messages",
						baseUrl: "",
						reasoning: true,
						input: ["text"],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 0,
						maxTokens: 0,
					}) as any,
			});

			await bash.execute("call-3", { command: "git commit -m 'msg'" });
			await bash.execute("call-4", { command: "git status" });
			await bash.execute("call-5", { command: "git log --oneline -n 5" });
			await bash.execute("call-6", { command: "git diff HEAD~1" });
			await bash.execute("call-7", { command: "rm /tmp/foo" });
			await bash.execute("call-8", { command: "ls -la" });
			expect(invokedCount).toBe(6);
		});

		it("does not enforce restrictions when no getModel is provided", async () => {
			let invoked = false;
			const bash = createBashTool(process.cwd(), {
				operations: {
					exec: async () => {
						invoked = true;
						return { exitCode: 0 };
					},
				},
			});

			await bash.execute("call-6", { command: "rm -rf /tmp/foo" });
			expect(invoked).toBe(true);
		});

		it("uses the latest model each call (model switches apply to the next invocation)", async () => {
			let current = "anthropic";
			const bash = createBashTool(process.cwd(), {
				operations: {
					exec: async () => ({ exitCode: 0 }),
				},
				getModel: () => ({ provider: current }) as any,
			});

			await bash.execute("call-7", { command: "rm -rf /tmp/foo" });
			current = RESTRICTED;
			await expect(bash.execute("call-8", { command: "rm -rf /tmp/foo" })).rejects.toBeInstanceOf(
				BashCommandRestrictedError,
			);
		});
	});
});
