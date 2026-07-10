import { parseCommandArgs } from "./slash-parser.js";

export type SkillActivationTrigger = "user-slash" | "model-tool";

export interface SkillActivationInput {
  name: string;
  args: string;
  body: string;
  sourcePath?: string;
  trigger: SkillActivationTrigger;
}

export interface SkillActivationMetadata {
  skillName: string;
  skillArgs: string;
  skillSourcePath: string | undefined;
  skillTrigger: SkillActivationTrigger;
}

export interface SkillActivationResult {
  prompt: string;
  metadata: SkillActivationMetadata;
}

const ARGUMENT_PLACEHOLDER_PATTERN = /\$ARGUMENTS(?:\[(\d+)\])?|\$(\d+)/g;

export function renderSkillBody(body: string, rawArgs: string): string {
  if (!ARGUMENT_PLACEHOLDER_PATTERN.test(body)) {
    return rawArgs.trim() ? `${body}\n\nARGUMENTS: ${rawArgs}` : body;
  }

  ARGUMENT_PLACEHOLDER_PATTERN.lastIndex = 0;
  const argv = parseCommandArgs(rawArgs);
  return body.replace(
    ARGUMENT_PLACEHOLDER_PATTERN,
    (placeholder, argumentIndex: string | undefined, shortIndex: string | undefined) => {
      if (placeholder === "$ARGUMENTS") return rawArgs;
      return argv[Number(argumentIndex ?? shortIndex)] ?? "";
    },
  );
}

export function renderSkillActivation(input: SkillActivationInput): SkillActivationResult {
  const renderedBody = renderSkillBody(input.body, input.args);
  const prompt = [
    `User explicitly activated skill "${input.name}". Follow the loaded skill instructions and use them to complete the request.`,
    "",
    `<pico-skill-loaded name="${escapeXmlAttribute(input.name)}" trigger="${escapeXmlAttribute(input.trigger)}" source="${escapeXmlAttribute(input.sourcePath ?? "")}">`,
    renderedBody,
    "</pico-skill-loaded>",
  ].join("\n");

  return {
    prompt,
    metadata: {
      skillName: input.name,
      skillArgs: input.args,
      skillSourcePath: input.sourcePath,
      skillTrigger: input.trigger,
    },
  };
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll("'", "&apos;")
    .replaceAll(">", "&gt;");
}
