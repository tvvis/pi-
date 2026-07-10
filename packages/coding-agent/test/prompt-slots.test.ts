/**
 * Unit tests for the named prompt slot registry (`core/prompt-slots.ts`).
 *
 * Covers:
 *   - `parsePromptSlots`: H2 section splitting, case-insensitive heading
 *     matching, empty/missing/unknown headings, trailing whitespace, body
 *     capture until next H2 or EOF.
 *   - `substitutePromptVars`: `${name}` replacement, undefined vars keep
 *     the literal, repeated occurrences are all replaced.
 */

import { describe, expect, test } from "vitest";
import { parsePromptSlots, substitutePromptVars } from "../src/core/prompt-slots.ts";

describe("parsePromptSlots", () => {
	test("returns all-undefined for empty content", () => {
		const out = parsePromptSlots("");
		expect(out).toEqual({ planMode: undefined, executePlan: undefined });
	});

	test("parses a single matching section (Plan Mode)", () => {
		const out = parsePromptSlots("## Plan Mode\n\nKeep it minimal.\n");
		expect(out.planMode).toBe("Keep it minimal.");
		expect(out.executePlan).toBeUndefined();
	});

	test("parses both planMode and executePlan sections", () => {
		const content = [
			"# Some header",
			"",
			"## Plan Mode",
			"",
			"Body for plan.",
			"",
			"## Executing Plan",
			"",
			"Body for execute.",
			"",
		].join("\n");
		const out = parsePromptSlots(content);
		expect(out.planMode).toBe("Body for plan.");
		expect(out.executePlan).toBe("Body for execute.");
	});

	test("matches headings case-insensitively and trims whitespace", () => {
		const content = ["##  plan   MODE  ", "", "trimmed body", "## executing plan", "", "exec body"].join("\n");
		const out = parsePromptSlots(content);
		expect(out.planMode).toBe("trimmed body");
		expect(out.executePlan).toBe("exec body");
	});

	test("skips H1 and any unknown H2 sections", () => {
		const content = [
			"# Top header",
			"",
			"intro paragraph",
			"",
			"## Random Section",
			"",
			"should be ignored",
			"",
			"## Plan Mode",
			"",
			"kept body",
		].join("\n");
		const out = parsePromptSlots(content);
		expect(out.planMode).toBe("kept body");
		expect(out.executePlan).toBeUndefined();
	});

	test("first section wins on duplicate headings", () => {
		const content = ["## Plan Mode", "", "first", "## Plan Mode", "", "second"].join("\n");
		expect(parsePromptSlots(content).planMode).toBe("first");
	});

	test("treats empty body as undefined", () => {
		const content = "## Plan Mode\n\n## Executing Plan\n\nbody";
		const out = parsePromptSlots(content);
		expect(out.planMode).toBeUndefined();
		expect(out.executePlan).toBe("body");
	});

	test("captures multi-line body until next H2 or EOF", () => {
		const content = "## Plan Mode\n\nline 1\nline 2\n\n\n## Next\n";
		expect(parsePromptSlots(content).planMode).toBe("line 1\nline 2");
	});

	test("trim trailing blank lines / whitespace per slot body", () => {
		const content = "## Plan Mode\n\nbody\n\n\n   \n";
		expect(parsePromptSlots(content).planMode).toBe("body");
	});

	test("handles CRLF line endings", () => {
		const content = "## Plan Mode\r\n\r\ncrlf body\r\n## Executing Plan\r\n\r\ncrlf exec\r\n";
		const out = parsePromptSlots(content);
		expect(out.planMode).toBe("crlf body");
		expect(out.executePlan).toBe("crlf exec");
	});
});

describe("substitutePromptVars", () => {
	test("replaces single occurrence", () => {
		expect(substitutePromptVars(`hello \${name}`, { name: "world" })).toBe("hello world");
	});

	test("replaces repeated occurrences", () => {
		expect(substitutePromptVars(`\${a}-\${a}`, { a: "X" })).toBe("X-X");
	});

	test("preserves literal when var undefined", () => {
		expect(substitutePromptVars(`a=\${missing} b=\${other}`, { other: "b" })).toBe(`a=\${missing} b=b`);
	});

	test("supports alphanumeric + underscore identifiers", () => {
		expect(substitutePromptVars(`\${planPath}-\${plan_title}`, { planPath: "p", plan_title: "t" })).toBe("p-t");
	});

	test("rejects malformed patterns", () => {
		// spaces inside braces are NOT matched (per the regex)
		expect(substitutePromptVars(`\${ bad } \${name}`, { name: "n" })).toBe(`\${ bad } n`);
	});

	test("empty template returns empty string", () => {
		expect(substitutePromptVars("", { x: "1" })).toBe("");
	});
});
