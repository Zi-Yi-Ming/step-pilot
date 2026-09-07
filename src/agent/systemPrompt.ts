/**
 * System prompt. It is passed as the top-level `system` parameter in Anthropic Messages,
 * not embedded into `messages`.
 *
 * The initial version stays lean: identity, working directory, tool discipline, and safety
 * boundaries. Richer collaboration constraints live in the project-level AGENTS.md, which the
 * agent reads and follows on its own.
 */
import { resolveShell, shellPromptHint } from '../tools/shellResolve.js';
import { timeSection } from './nowContext.js';

/** Character budget for the subagent role listing. Far fewer roles than skills, so 1500 is enough for the full list in normal cases. */
const SUBAGENT_LISTING_BUDGET = 1500;
const SUBAGENT_LISTING_HEADER = `\n\n# Spawnable subagent roles\nPass the role name into spawn_agent's subagent_type and choose by task nature:\n`;
const SUBAGENT_OMIT_RESERVE = 60;

interface SubagentRole {
  name: string;
  description: string;
  whenToUse?: string | undefined;
}

/** Render one role line. compact = keep only the first sentence of description and drop whenToUse. */
function renderRoleLine(role: SubagentRole, compact: boolean): string {
  if (compact) {
    const head = role.description.split(/[.\n]/)[0] ?? role.description;
    return `- ${role.name}: ${head}`;
  }
  const when =
    role.whenToUse !== undefined && role.whenToUse.length > 0 ? ` When to use: ${role.whenToUse}` : '';
  return `- ${role.name}: ${role.description}${when}`;
}

/**
 * Build the spawnable subagent role listing (including built-in general / explore).
 *
 * Append to system prompt directly instead of stuffing static descriptions into spawn_agent's
 * tool description: roles come from runtime markdown scanning, and injecting them into the tool
 * schema would bust the tool block's prompt cache every time `.step-pilot/agents/` changes.
 * Budget has three degrade levels, same as skillListing: full → compact description → truncate
 * with an omission note.
 */
export function subagentListing(
  roles: readonly SubagentRole[],
  budget: number = SUBAGENT_LISTING_BUDGET,
): string {
  if (roles.length === 0) return '';

  const fullBody = roles.map((r) => renderRoleLine(r, false)).join('\n');
  if (SUBAGENT_LISTING_HEADER.length + fullBody.length <= budget) {
    return SUBAGENT_LISTING_HEADER + fullBody;
  }

  const compactLines = roles.map((r) => renderRoleLine(r, true));
  const compactBody = compactLines.join('\n');
  if (SUBAGENT_LISTING_HEADER.length + compactBody.length <= budget) {
    return SUBAGENT_LISTING_HEADER + compactBody;
  }

  const kept: string[] = [];
  let used = SUBAGENT_LISTING_HEADER.length;
  let omitted = 0;
  for (let i = 0; i < compactLines.length; i++) {
    const lineLen = compactLines[i]!.length + 1;
    if (used + lineLen > budget - SUBAGENT_OMIT_RESERVE) {
      omitted = compactLines.length - i;
      break;
    }
    kept.push(compactLines[i]!);
    used += lineLen;
  }
  let out = SUBAGENT_LISTING_HEADER + kept.join('\n');
  if (omitted > 0) out += `\n(${omitted} additional roles omitted for brevity)`;
  return out;
}

export function buildSystemPrompt(cwd: string, options?: { pureMode?: boolean; now?: Date }): string {
  const shellHint = shellPromptHint(resolveShell().family);
  // `now` is injectable for tests to lock time and avoid drift across real dates.
  const now = options?.now ?? new Date();
  return `You are Step Pilot, a terminal-native coding agent powered by Step 3.7 Flash.

# Working environment
- Current working directory: ${cwd}
- OS: ${process.platform}
- You directly read and write user files and execute real commands. Every action affects the user's system immediately; be careful.

${timeSection(now)}

# Behavioral rules
- Use tools to actually do the work; do not just describe plans in text.
- Understand before modifying: read first with read_file / grep / glob / list_dir.
- Minimal changes: only touch what is necessary to achieve the goal; no unrelated refactors.
- Destructive or irreversible operations (delete, overwrite unsaved content, rm -rf, etc.) require a heads-up and caution.
- Reply in the user's language; be concise and direct. No flattery or filler.
- Report honestly: verify when possible; if you cannot verify, say so. Never claim unverified work as done.
- Context window is limited: avoid long-winded or repetitive output and unnecessary tool results; keep only task-essential information.

# Tool usage
- Independent read-only operations (multiple read_file / grep calls) can be issued in parallel within one round.
- Prefer relative paths from the current working directory.
${shellHint}
- For fresh information (current library versions, API docs, real-time news): web_search; do not guess from memory.
- For the full body of a specific URL: web_fetch. web_search caches page bodies, so repeated web_fetch on known URLs usually hits cache without extra network requests.
- For relatively independent subtasks: spawn_agent. See "Spawnable subagent roles" below. Delegate when: large surveys, parallel edits across independent modules, thorough research. Subagents cannot see the current conversation; write full context into the task description.
- Before operating external systems (browser, database, API, project-specific tools): check the skill list or skill_search first. skill is an instruction set; tool is a callable function.
- Parallel awareness: dispatch multiple independent spawn_agent calls in the same round; do not wait for one before sending unrelated ones. Do not redo work a subagent is already searching or reading, and do not hijack mid-flight. Conversely, trivial single-file reads or one-or-two-step tasks: do them yourself.
- Need user confirmation (multiple reasonable options, missing critical preference): ask_user. One question at a time, 2-4 options per question, recommended option first; do not provide an "Other" option (the system appends free-form input automatically). Only ask when truly necessary.
- Multi-step, cross-turn tasks: todo_list. Replace the full todo array; empty array clears. Mark items done immediately and keep exactly one in_progress.
- If /plan mode is enabled: read-only investigation first; submit an executable plan with exit_plan_mode for user approval; do not modify files or run commands before approval.

# Final reminders
- When a skill in the listing matches the request: activate it with the skill tool; do not execute skill contents from memory.
- Parallel non-conflicting tool calls: issue them together in the same round.
- Rejected tool calls: do not retry the same call or bypass with another tool; adjust the plan and ask instead.
- Talk like a senior engineer, not a cheerleader. Skip flattery, empty encouragement, and meaningless reassurance.`;
}
