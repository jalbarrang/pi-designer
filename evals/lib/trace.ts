/**
 * Parse `pi --mode json` stdout into the trace the graders assert on.
 *
 * The wire format is JSONL (split on LF only — readline also splits on Unicode
 * line separators). Assistant messages carry toolCall blocks; tool results
 * arrive as `tool_execution_end` (and again inside `turn_end.toolResults`).
 * Both are consumed so a change in one event does not blind the grader.
 *
 * The system message arrives with its `sections` map, which is how designer's
 * one always-on surface — the `design_context` prompt section — becomes
 * gradable without a model's cooperation.
 */

import type { RunTrace, ToolCall } from './types';

type Obj = Record<string, unknown>;

const asObj = (value: unknown): Obj | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Obj)
    : undefined;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

export function contentText(content: unknown): string {
  return asArray(content)
    .map((block) => {
      const obj = asObj(block);
      return obj?.type === 'text' ? str(obj.text) : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** `{ name: sectionText }` from a system message, or undefined for other roles. */
function systemSections(message: Obj): Record<string, string> | undefined {
  if (message.role !== 'system') return undefined;
  const sections = asObj(message.sections);
  if (!sections) return undefined;

  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(sections)) {
    if (typeof value === 'string') out[name] = value;
  }
  return out;
}

export function parseTranscript(stdout: string): RunTrace {
  const calls = new Map<string, ToolCall>();
  const order: string[] = [];
  const assistantTexts: string[] = [];
  const systemSectionsByName: Record<string, string> = {};
  const usage = { input: 0, output: 0, nested: 0 };
  let events = 0;
  let parseErrors = 0;

  const recordCall = (id: string, name: string, args: Obj): void => {
    if (calls.has(id)) return;
    calls.set(id, { id, name, args });
    order.push(id);
  };

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;

    let record: Obj | undefined;
    try {
      record = asObj(JSON.parse(line));
    } catch {
      parseErrors += 1;
      continue;
    }
    if (!record) continue;
    events += 1;

    // The system message can arrive at message_start or message_end depending
    // on the runtime; both carry the same sections, so the last one wins.
    if (record.type === 'message_start' || record.type === 'message_end') {
      const sections = systemSections(asObj(record.message) ?? {});
      if (sections) Object.assign(systemSectionsByName, sections);
    }

    if (record.type === 'message_end') {
      const message = asObj(record.message);
      if (!message) continue;

      if (message.role === 'assistant') {
        const messageUsage = asObj(message.usage);
        if (messageUsage) {
          usage.input += num(messageUsage.input);
          usage.output += num(messageUsage.output);
        }
        const text = contentText(message.content);
        if (text) assistantTexts.push(text);
        for (const block of asArray(message.content)) {
          const call = asObj(block);
          if (call?.type !== 'toolCall' || typeof call.name !== 'string') continue;
          const id = typeof call.id === 'string' ? call.id : `${call.name}-${order.length}`;
          recordCall(id, call.name, asObj(call.arguments) ?? {});
        }
      }

      // Nested model work (an engine subprocess that reports usage).
      if (message.role === 'toolResult') {
        const messageUsage = asObj(message.usage);
        if (messageUsage) usage.nested += num(messageUsage.input) + num(messageUsage.output);
      }
    }

    if (record.type === 'tool_execution_end') {
      const id = typeof record.toolCallId === 'string' ? record.toolCallId : '';
      const call = calls.get(id);
      const result = asObj(record.result);
      if (!call || !result) continue;
      call.resultText = contentText(result.content);
      call.details = result.details;
      call.isError = record.isError === true;
    }

    if (record.type === 'turn_end') {
      for (const item of asArray(record.toolResults)) {
        const resultMessage = asObj(item);
        if (!resultMessage) continue;
        const id = typeof resultMessage.toolCallId === 'string' ? resultMessage.toolCallId : '';
        const call = calls.get(id);
        if (!call || call.resultText !== undefined) continue;
        call.resultText = contentText(resultMessage.content);
        call.details = resultMessage.details;
        call.isError = resultMessage.isError === true;
      }
    }
  }

  return {
    calls: order.map((id) => calls.get(id)!),
    assistantText: assistantTexts.at(-1) ?? '',
    allAssistantText: assistantTexts.join('\n\n'),
    systemSections: systemSectionsByName,
    usage,
    events,
    parseErrors,
  };
}
