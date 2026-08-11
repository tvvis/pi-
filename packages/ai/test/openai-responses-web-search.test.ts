import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { convertResponsesTools } from "../src/providers/openai-responses-shared.ts";
import type { Tool } from "../src/types.ts";

const echoTool: Tool = {
	name: "echo",
	description: "echo back the input",
	parameters: Type.Object({ message: Type.String() }),
};

describe("convertResponsesTools web_search", () => {
	it("appends the built-in web_search tool when includeWebSearch is true", () => {
		const tools = convertResponsesTools([echoTool], { includeWebSearch: true });
		expect(tools).toHaveLength(2);
		expect(tools[0]).toMatchObject({ type: "function", name: "echo" });
		expect(tools[1]).toEqual({ type: "web_search" });
	});

	it("appends web_search even with no function tools", () => {
		const tools = convertResponsesTools([], { includeWebSearch: true });
		expect(tools).toEqual([{ type: "web_search" }]);
	});

	it("does not append web_search by default", () => {
		const tools = convertResponsesTools([echoTool]);
		expect(tools).toHaveLength(1);
		expect(tools[0]).toMatchObject({ type: "function", name: "echo" });
	});

	it("does not append web_search when includeWebSearch is false", () => {
		const tools = convertResponsesTools([echoTool], { includeWebSearch: false });
		expect(tools).toHaveLength(1);
	});
});
