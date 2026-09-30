// Round 8b: robust single-tool call for the helper passes (on-image spelling
// read, card text compare).
//
// First production run on Opus 5.5 (2026-09-30): every spelling read came
// back "couldn't verify" while the same ads read fine on Sonnet 5 an hour
// earlier. The helper calls force the tool (tool_choice {type:"tool"}) and
// Opus 5.5 always thinks, so that combination is the prime suspect — and the
// catch swallowed the error, so the logs couldn't say. This helper:
//   1. tries the forced-tool call (unchanged behavior where it works),
//   2. on an API error, retries ONCE the same way the main QA call already
//      runs successfully on Opus 5.5: tool_choice auto + adaptive thinking,
//      with an explicit "call the tool" instruction,
//   3. logs the first failure reason so the cause is visible in Vercel.
// Never throws; returns null when no tool call came back.
import type Anthropic from "@anthropic-ai/sdk";

let loggedForcedFailure = false;

export async function callSingleTool(
  client: Anthropic,
  params: {
    model: string;
    maxTokens: number;
    system: string;
    tool: Anthropic.Tool;
    content: Anthropic.MessageParam["content"];
  },
  log: (msg: string) => void = console.log
): Promise<{ input: unknown; stopReason: string | null } | null> {
  const pick = (msg: Anthropic.Message) => {
    const t = msg.content.find((b) => b.type === "tool_use");
    return t && t.type === "tool_use" ? { input: t.input, stopReason: msg.stop_reason } : null;
  };
  try {
    const msg = await client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      tools: [params.tool],
      tool_choice: { type: "tool", name: params.tool.name },
      messages: [{ role: "user", content: params.content }],
    });
    const got = pick(msg);
    if (got) return got;
    if (!loggedForcedFailure) {
      loggedForcedFailure = true;
      console.log(`[qa][toolcall] forced ${params.tool.name} returned no tool call (stop_reason=${msg.stop_reason}); retrying with auto`);
    }
  } catch (err) {
    if (!loggedForcedFailure) {
      loggedForcedFailure = true;
      console.log(`[qa][toolcall] forced ${params.tool.name} failed on ${params.model}: ${err instanceof Error ? err.message : String(err)} — retrying with auto`);
    }
  }
  try {
    const msg = await client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: `${params.system}\n\nSubmit your answer by calling the \`${params.tool.name}\` tool exactly once. Do not answer in plain text.`,
      tools: [params.tool],
      tool_choice: { type: "auto" },
      messages: [{ role: "user", content: params.content }],
    });
    const got = pick(msg);
    if (!got) log(`[qa][toolcall] ${params.tool.name} auto retry returned no tool call (stop_reason=${msg.stop_reason})`);
    return got;
  } catch (err) {
    console.log(`[qa][toolcall] ${params.tool.name} auto retry failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
