import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import { adaptSystemPrompt, rewriteDefaultPrompt } from "../src/prompt.ts";

// Test-only: generate Pi's real built-in prompt from the pinned dev dependency so wording
// drift in a Pi update fails here instead of silently disabling the adaptation.
const core = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/core/", import.meta.url);
const { buildSystemPromptSections } = await import(new URL("system-prompt.js", core).href);
const builtins = ["read", "bash", "edit", "write", "grep", "find", "ls", "powershell"] as const;
const contributions = Object.fromEntries(await Promise.all(builtins.map(async (name) => {
	const module = await import(new URL(`tools/${name}.js`, core).href);
	return [name, module[`${name}ToolSystemPromptContribution`] as { snippet: string; guidelines: readonly string[] }];
})));
const { getDocsPath, getExamplesPath, getReadmePath } = await import(new URL("../config.js", core).href);

const CONTEXT_PATH = "/workspace/project/AGENTS.md";
const CONTEXT_TEXT = "Keep pi rules verbatim.\n- Be concise in your responses";
const SKILL_PATH = "/home/user/.pi/agent/skills/demo/SKILL.md";
const SKILL_DESCRIPTION = "Demo skill for pi.";
const CWD = "/workspace/project";

function piSections(selectedTools: readonly string[], extra: Record<string, string> = {}): Record<string, string> {
	return buildSystemPromptSections({
		selectedTools: [...selectedTools],
		toolSnippets: Object.fromEntries(selectedTools.map((name) => [name, contributions[name]!.snippet])),
		toolGuidelines: Object.fromEntries(selectedTools.map((name) => [name, [...contributions[name]!.guidelines]])),
		contextFiles: [{ path: CONTEXT_PATH, content: CONTEXT_TEXT }],
		skills: [{ name: "demo", description: SKILL_DESCRIPTION, filePath: SKILL_PATH, baseDir: "/home/user/.pi/agent/skills/demo", source: "user", disableModelInvocation: false }],
		cwd: CWD,
		sections: extra,
	});
}

function system(sections: Record<string, string | null>, content = ""): SystemMessage {
	return { role: "system", content, sections, timestamp: 0 };
}

/** Every Pi-authored sentence the adaptation targets, read from the generated prompt itself. */
function builtinProse(sections: Record<string, string>): string[] {
	const prose = [sections.preamble!];
	for (const [name, section] of Object.entries(sections)) {
		if (!["tools", "rules", "docs", "project_context", "skills"].includes(name)) continue;
		for (const line of section.split("\n")) {
			if (!line.trim() || /^<\/?[a-z_]+>$/.test(line) || line.includes(CONTEXT_PATH) || line.includes("<skill>") || line.includes("</skill>")) continue;
			if (line.includes(SKILL_PATH) || line.includes("<name>") || line.includes("<description>") || /available_skills/.test(line)) continue;
			if (/^- (Main documentation|Additional docs|Examples): /.test(line)) continue;
			if (CONTEXT_TEXT.includes(line)) continue;
			prose.push(line);
		}
	}
	return prose;
}

const withoutPaths = (text: string) => [getReadmePath(), getDocsPath(), getExamplesPath(), SKILL_PATH]
	.reduce((result, path: string) => result.replaceAll(path, "<path>"), text);

for (const selected of [["read", "bash", "edit", "write"], [...builtins], ["bash"], ["powershell"], ["bash", "powershell"], ["read"], ["ls"]]) {
	test(`adapts every built-in Pi sentence without losing data (${selected.join(",")})`, () => {
		const sections = piSections(selected);
		const message = system(sections);
		const frozen = structuredClone(message);
		const prompt = adaptSystemPrompt([message]);
		assert.deepEqual(message, frozen, "the transcript must not be mutated");
		for (const sentence of builtinProse(sections)) {
			assert.equal(prompt.includes(sentence), false, `Pi prose survived adaptation: ${sentence}`);
		}
		// User-provided rule and skill text may mention pi; only Pi's own prose must not.
		assert.doesNotMatch(withoutPaths(prompt).replace(CONTEXT_TEXT, "").replace(SKILL_DESCRIPTION, ""), /\bpi\b/i);
		// Functional data stays exact: documentation and skill locations, user rules, cwd, tools.
		// Pi itself omits skills when no file-reading tool is selected.
		if (sections.skills) assert.ok(prompt.includes(`<description>${SKILL_DESCRIPTION}</description>\n    <location>${SKILL_PATH}</location>`));
		for (const kept of [getReadmePath(), getDocsPath(), getExamplesPath(), `<project_instructions path="${CONTEXT_PATH}">\n${CONTEXT_TEXT}\n</project_instructions>`, `<cwd>\n${CWD}\n</cwd>`]) {
			assert.ok(prompt.includes(kept), `missing ${kept}`);
		}
		for (const name of selected.filter((tool) => contributions[tool]!.snippet)) assert.match(prompt, new RegExp(`^- ${name}: `, "m"));
		// Every section keeps its wrapper and its order.
		const positions = Object.keys(sections).filter((name) => name !== "preamble").map((name) => prompt.indexOf(`\n\n<${name}>\n`));
		assert.ok(positions.every((position, index) => position > 0 && (index === 0 || position > positions[index - 1]!)), "section structure is preserved");
		assert.ok(prompt.startsWith("You are a coding agent helping the user with their project.\n\n<tools>\n"));
	});
}

test("leaves custom, extension and user-provided sections byte-for-byte unchanged", () => {
	const extension = "<session_ui_meta>\nUse pi metadata.\n- Be concise in your responses\n</session_ui_meta>";
	const sections = piSections(["read", "bash", "grep"], { session_ui_meta: "Use pi metadata.\n- Be concise in your responses" });
	assert.equal(sections.session_ui_meta, extension);
	// An extension that overrides a built-in snippet keeps its own wording.
	sections.tools = sections.tools!.replace("- grep: Search file contents for patterns (respects .gitignore)", "- grep: Grep contents");
	const prompt = adaptSystemPrompt([system(sections)]);
	assert.ok(prompt.endsWith(extension));
	assert.ok(prompt.includes("- grep: Grep contents"));
	assert.ok(prompt.includes(`\n${CONTEXT_TEXT}\n`));
});

test("custom preambles, edited docs and forced prompts are not rewritten", () => {
	const custom = buildSystemPromptSections({ customPrompt: "You are pi's custom helper.", cwd: CWD });
	assert.equal(adaptSystemPrompt([system(custom)]), `You are pi's custom helper.\n\n<cwd>\n${CWD}\n</cwd>`);
	const docs = piSections(["read"]).docs!.replace("TUI components", "TUI widgets");
	assert.equal(adaptSystemPrompt([system({ docs })]), docs, "unrecognized docs text must pass through unchanged");
	const forced = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.\nCustom pi rules.";
	assert.equal(adaptSystemPrompt([{ role: "system", content: forced, timestamp: 0 }]), rewriteDefaultPrompt(forced));
	assert.ok(adaptSystemPrompt([{ role: "system", content: forced, timestamp: 0 }]).endsWith("\nCustom pi rules."));
	assert.equal(adaptSystemPrompt([]), "");
});

test("applies later section patches before adapting", () => {
	const initial = piSections(["read", "bash"]);
	const messages: Message[] = [
		system(initial),
		{ role: "user", content: "hello", timestamp: 1 },
		system({ rules: "<rules>\n- Use write only for new files or complete rewrites.\n- Custom pi rule\n</rules>", docs: null }),
	];
	const prompt = adaptSystemPrompt(messages);
	assert.ok(prompt.includes("<rules>\n- Reserve write for new files or full rewrites.\n- Custom pi rule\n</rules>"));
	assert.equal(prompt.includes("<docs>"), false);
});

test("project instructions never embed the Pi prose known to trigger backend rejection", () => {
	const instructions = readFileSync(new URL("../AGENTS.md", import.meta.url), "utf8");
	const sections = piSections([...builtins]);
	for (const line of [sections.preamble!, ...sections.docs!.split("\n").filter((line) => line.startsWith("- When asked about:"))]) {
		assert.equal(instructions.includes(line), false);
	}
});
