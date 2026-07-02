/**
 * Tests for the plan-mode state module.
 *
 * Covers: enter/exit lifecycle, draftRoot computation, path allowlist,
 * and the error class shapes thrown by the tool guards.
 */

import { homedir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	derivePlanSlug,
	enterPlanMode,
	exitPlanMode,
	getDraftRoot,
	getPlanModeState,
	isInPlanMode,
	isPathAllowedInPlanMode,
	PlanModeBashDisabledError,
	PlanModeWriteError,
} from "../../src/modes/interactive/plan-mode-state.ts";

const SESSION_ID = "test-session-001";

afterEach(() => {
	exitPlanMode();
});

describe("plan-mode state lifecycle", () => {
	it("is not active by default", () => {
		expect(isInPlanMode()).toBe(false);
		expect(getPlanModeState()).toBeNull();
		expect(getDraftRoot()).toBeNull();
	});

	it("enter sets active state with derived draftRoot", () => {
		const state = enterPlanMode({ sessionId: SESSION_ID });
		expect(state.active).toBe(true);
		expect(state.sessionId).toBe(SESSION_ID);
		expect(state.draftRoot).toBe(join(homedir(), ".pi", "draft", SESSION_ID));
		expect(state.description).toBeUndefined();
		expect(isInPlanMode()).toBe(true);
		expect(getDraftRoot()).toBe(state.draftRoot);
	});

	it("enter with description sets description", () => {
		const state = enterPlanMode({ sessionId: SESSION_ID, description: "add rate limiting" });
		expect(state.description).toBe("add rate limiting");
	});

	it("exit clears state", () => {
		enterPlanMode({ sessionId: SESSION_ID });
		expect(isInPlanMode()).toBe(true);
		exitPlanMode();
		expect(isInPlanMode()).toBe(false);
		expect(getPlanModeState()).toBeNull();
		expect(getDraftRoot()).toBeNull();
	});

	it("enter is idempotent: a second enter replaces the first", () => {
		const first = enterPlanMode({ sessionId: "a" });
		const second = enterPlanMode({ sessionId: "b", description: "second" });
		expect(second.sessionId).toBe("b");
		expect(second.description).toBe("second");
		expect(getPlanModeState()).toBe(second);
		expect(getPlanModeState()).not.toBe(first);
	});
});

describe("isPathAllowedInPlanMode", () => {
	it("returns true for any path when plan mode is off", () => {
		expect(isPathAllowedInPlanMode("/etc/passwd")).toBe(true);
		expect(isPathAllowedInPlanMode("/home/user/project/foo.ts")).toBe(true);
	});

	it("returns true for paths inside the draft root", () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		expect(isPathAllowedInPlanMode(join(draftRoot, "draft.md"))).toBe(true);
		expect(isPathAllowedInPlanMode(join(draftRoot, "subdir", "note.md"))).toBe(true);
	});

	it("returns true for the draft root itself", () => {
		enterPlanMode({ sessionId: SESSION_ID });
		expect(isPathAllowedInPlanMode(getDraftRoot()!)).toBe(true);
	});

	it("returns false for paths outside the draft root", () => {
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		// Sibling directory of the same parent
		expect(isPathAllowedInPlanMode(join(draftRoot, "..", "other", "foo.md"))).toBe(false);
		// Project files
		expect(isPathAllowedInPlanMode("/home/user/project/src/foo.ts")).toBe(false);
	});

	it("does not allow a prefix that just looks like the draft root", () => {
		// e.g. draftRoot is ~/.pi/draft/abc/ — the path ~/.pi/draft/abcdef/foo
		// should NOT pass (note the missing separator).
		enterPlanMode({ sessionId: SESSION_ID });
		const draftRoot = getDraftRoot()!;
		const tricky = `${draftRoot}not-the-same-session/file.md`;
		expect(isPathAllowedInPlanMode(tricky)).toBe(false);
		// Sanity: the exact draft root + sep + something does pass.
		expect(isPathAllowedInPlanMode(`${draftRoot}${sep}file.md`)).toBe(true);
	});
});

describe("error classes", () => {
	it("PlanModeWriteError carries attempted path and draft root in its message", () => {
		const err = new PlanModeWriteError("/foo/bar", "/home/x/.pi/draft/sid");
		expect(err.name).toBe("PlanModeWriteError");
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toContain("/foo/bar");
		expect(err.message).toContain("/home/x/.pi/draft/sid");
	});

	it("PlanModeBashDisabledError mentions bash and the draft convention", () => {
		const err = new PlanModeBashDisabledError();
		expect(err.name).toBe("PlanModeBashDisabledError");
		expect(err).toBeInstanceOf(Error);
		expect(err.message).toMatch(/bash/i);
		expect(err.message).toContain("~");
	});
});

describe("derivePlanSlug", () => {
	it("uses the title from `# Plan: <Title>`", () => {
		expect(derivePlanSlug("# Plan: Add rate limiting\n\nbody")).toBe("add-rate-limiting");
	});

	it("uses the title from `# Plan - <Title>`", () => {
		expect(derivePlanSlug("# Plan - Fix Login Bug\n\nbody")).toBe("fix-login-bug");
	});

	it("falls back to plain H1 when there is no `Plan:` prefix", () => {
		expect(derivePlanSlug("# Refactor the auth flow\n\nbody")).toBe("refactor-the-auth-flow");
	});

	it("lowercases and collapses non-alphanumerics to hyphens", () => {
		expect(derivePlanSlug("# Plan: Add User's Auth!!! (v2)\n")).toBe("add-user-s-auth-v2");
	});

	it("strips leading and trailing hyphens", () => {
		expect(derivePlanSlug("# Plan: ---Hello World---\n")).toBe("hello-world");
	});

	it("ignores lines that are not H1s", () => {
		expect(derivePlanSlug("## H2 not H1\n## another H2\n# Real Title\n")).toBe("real-title");
	});

	it("caps at 80 characters", () => {
		const long = "a".repeat(200);
		const slug = derivePlanSlug(`# Plan: ${long}\n`);
		expect(slug.length).toBeLessThanOrEqual(80);
	});

	it("falls back to `plan-<timestamp>` when no H1 is present", () => {
		const before = Date.now();
		const slug = derivePlanSlug("no headings here\njust body text\n");
		const after = Date.now();
		expect(slug).toMatch(/^plan-\d+$/);
		const ts = Number(slug.slice("plan-".length));
		expect(ts).toBeGreaterThanOrEqual(before);
		expect(ts).toBeLessThanOrEqual(after);
	});

	it("falls back to `plan-<timestamp>` when the title slugifies to empty", () => {
		const slug = derivePlanSlug("# !!!\n");
		expect(slug).toMatch(/^plan-\d+$/);
	});

	it("does not match `## ` (H2) as an H1", () => {
		const slug = derivePlanSlug("## H2 heading\n");
		expect(slug).toMatch(/^plan-\d+$/);
	});
});
