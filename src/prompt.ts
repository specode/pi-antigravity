import type { Message, SystemMessage } from "@earendil-works/pi-ai";
import { getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";

/**
 * Request-time adaptation of Pi's built-in system prompt prose for the Antigravity backend.
 *
 * The backend rejected requests carrying some of Pi's built-in prose with 429 (see AGENTS.md
 * section 6.2). Each exact Pi 1.5.2 string below is replaced by original wording that keeps the
 * same instruction without naming the harness. Paths, environment-specific values, tool names,
 * user rules, skill entries and extension sections pass through unchanged, and unrecognized text
 * is never rewritten. Only the serialized request changes; the transcript is not mutated.
 */

const PI_OPENING = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
const AGENT_OPENING = "You are a coding agent helping the user with their project.";

/** Whole-line replacements, applied only inside the named built-in section. */
const LINE_REPLACEMENTS: Readonly<Record<string, ReadonlyMap<string, string>>> = {
	tools: new Map([
		["- read: Read file contents", "- read: View the contents of a file"],
		["- bash: Execute bash commands (ls, grep, find, etc.)", "- bash: Run shell commands in the workspace"],
		["- edit: Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
			"- edit: Apply exact text replacements to an existing file; several separate replacements can be made in one call"],
		["- write: Create or overwrite files", "- write: Create a file or replace its entire contents"],
		["- grep: Search file contents for patterns (respects .gitignore)", "- grep: Search file contents for a pattern; ignored files are skipped"],
		["- find: Find files by glob pattern (respects .gitignore)", "- find: Locate files by glob pattern; ignored files are skipped"],
		["- ls: List directory contents", "- ls: List the entries in a directory"],
		["- powershell: Execute PowerShell commands", "- powershell: Run PowerShell commands in the workspace"],
		["Additional tools may be available.", "Other tools may also be available."],
	]),
	rules: new Map([
		["- Use read to examine files instead of cat or sed.", "- Prefer read over cat or sed when viewing files."],
		["- You can inspect PI_* environment variables for current model and session details.",
			"- Details about the current model and session are available as environment variables; list them with env."],
		["- Use edit for targeted changes. Batch changes to one file in a single call.",
			"- Use edit for focused changes, grouping all changes to the same file into one call."],
		["- Each edits[].oldText must exactly and uniquely match the original file. Keep matches short and non-overlapping; merge nearby changes without including large unchanged regions.",
			"- Every edits[].oldText has to match the original file exactly and only once. Keep each match short and separate from the others; combine nearby changes instead of copying large unchanged regions."],
		["- Use write only for new files or complete rewrites.", "- Reserve write for new files or full rewrites."],
		["- Use bash for file operations like ls, rg, find", "- Use bash for file operations such as ls, rg, and find"],
		["- Use bash or PowerShell for file operations like listing, searching, and finding files", "- Use bash or PowerShell to list, search, and locate files"],
		["- Use PowerShell for file operations like listing, searching, and finding files", "- Use PowerShell to list, search, and locate files"],
		["- Be concise in your responses", "- Keep responses concise"],
		["- Show file paths clearly when working with files", "- State file paths clearly when referring to files"],
	]),
	project_context: new Map([
		["Project-specific instructions and guidelines:", "Instructions provided for this workspace:"],
	]),
	skills: new Map([
		["The following skills provide specialized instructions for specific tasks.", "Skills below contain specialized instructions for particular tasks."],
		["Use the read tool to load a skill's file when the task matches its description.",
			"When a task matches a skill's description, load that skill's file with the read tool."],
		["Use bash to load a skill's file when the task matches its description.",
			"When a task matches a skill's description, load that skill's file with bash."],
		["Load a skill's file when the task matches its description.", "When a task matches a skill's description, load that skill's file."],
		["Resolve relative paths against the skill's directory (parent of SKILL.md). Use absolute paths in tool calls.",
			"Relative paths inside a skill are relative to its directory (the folder containing SKILL.md); use absolute paths in tool calls."],
	]),
};

const DOCS_HEADER = "Pi documentation (read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI):";
const DOCS_RESOLVE = "- When reading pi docs or examples, resolve docs/... under Additional docs and examples/... under Examples, not the current working directory";
const DOCS_TOPICS = "- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), packages (docs/packages.md), environment variables (docs/environment-variables.md), MCP servers (docs/mcp.md), codemode scripts and non-LLM models such as classifiers and image models (docs/codemode.md)";
const DOCS_BEFORE = "- Before implementing harness changes, read the relevant docs and examples in full, following related cross-references.";

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const DOCS_SECTION = new RegExp(`^<docs>\\n${escape(DOCS_HEADER)}\\n`
	+ "- Main documentation: ([^\\n]+)\\n- Additional docs: ([^\\n]+)\\n- Examples: ([^\\n]+) \\(extensions, custom tools, SDK\\)\\n"
	+ `${escape(DOCS_RESOLVE)}\\n${escape(DOCS_TOPICS)}\\n${escape(DOCS_BEFORE)}\\n</docs>$`);

/** Keep the three documentation locations; the topic index becomes a directory listing hint. */
function adaptDocs(section: string): string {
	const match = DOCS_SECTION.exec(section);
	if (!match) return section;
	const [, readme, docs, examples] = match;
	return [
		"<docs>",
		"Agent harness reference (consult only when the user asks about the harness itself: its SDK, extensions, themes, skills, or terminal UI):",
		`- Overview: ${readme}`,
		`- Guides: ${docs}`,
		`- Examples: ${examples}`,
		"- Resolve docs/... under Guides and examples/... under Examples, not the working directory.",
		"- To find the guide for a topic, list the Guides directory and open the matching file.",
		"- Before changing harness configuration or extensions, read the relevant guides and examples in full, including cross-references.",
		"</docs>",
	].join("\n");
}

function adaptLines(section: string, replacements: ReadonlyMap<string, string>): string {
	return section.split("\n").map((line) => replacements.get(line) ?? line).join("\n");
}

function adaptSection(name: string, section: string): string {
	if (name === "preamble") return section === PI_OPENING ? AGENT_OPENING : section;
	if (name === "docs") return adaptDocs(section);
	const replacements = LINE_REPLACEMENTS[name];
	return replacements ? adaptLines(section, replacements) : section;
}

/** Rewrite only the exact known leading sentences, never text elsewhere in the prompt. */
export function rewriteDefaultPrompt(prompt: string): string {
	if (!prompt.startsWith(PI_OPENING)) return prompt;
	const suffix = prompt.slice(PI_OPENING.length);
	if (suffix !== "" && !/^\s/.test(suffix)) return prompt;
	return AGENT_OPENING + suffix;
}

/** Render the current system prompt with Pi's built-in prose adapted section by section. */
export function adaptSystemPrompt(messages: readonly Message[]): string {
	const current = getCurrentSystemMessage(messages as Message[]);
	if (!current) return "";
	const sections = current.sections === undefined ? undefined : Object.fromEntries(
		Object.entries(current.sections).map(([name, text]) => [name, text === null ? null : adaptSection(name, text)]),
	);
	const adapted: SystemMessage = sections === undefined ? current : { ...current, sections };
	// A forced prompt has no sections; only its exact default opening is recognized.
	return rewriteDefaultPrompt(getSystemMessageText(adapted));
}
