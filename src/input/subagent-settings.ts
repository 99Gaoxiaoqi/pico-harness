/*
 * Licensed to the Apache Software Foundation (ASF) under one
 * or more contributor license agreements.  See the NOTICE file
 * distributed with this work for additional information
 * regarding copyright ownership.  The ASF licenses this file
 * to you under the Apache License, Version 2.0 (the
 * "License"); you may not use this file except in compliance
 * with the License.  You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

// Adapted from Apache Maka core/subagent-settings.ts; Pico uses its shared protocol types.
import {
  MAX_SUBAGENT_PRESETS,
  SUBAGENT_PRESET_NAME_MAX_CHARS,
  SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS,
  SUBAGENT_PROFILES,
  SUBAGENT_THINKING_LEVELS,
  isSafeSubagentPresetId,
  type RuntimeSubagentPreset,
  type SubagentProfile,
  type SubagentThinkingLevel,
} from "@pico/protocol";

export interface PicoSubagentSettings {
  readonly presets: readonly RuntimeSubagentPreset[];
}

export function normalizePicoSubagentSettings(input: unknown): PicoSubagentSettings {
  if (
    !input ||
    typeof input !== "object" ||
    !Array.isArray((input as { presets?: unknown }).presets)
  ) {
    return { presets: [] };
  }
  const presets: RuntimeSubagentPreset[] = [];
  const seen = new Set<string>();
  for (const candidate of (input as { presets: unknown[] }).presets) {
    if (presets.length >= MAX_SUBAGENT_PRESETS) break;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const value = candidate as Record<string, unknown>;
    if (
      !isSafeSubagentPresetId(value.id) ||
      seen.has(value.id) ||
      !(
        typeof value.profile === "string" &&
        (SUBAGENT_PROFILES as readonly string[]).includes(value.profile)
      ) ||
      typeof value.name !== "string" ||
      value.name.trim().length < 1 ||
      value.name.trim().length > SUBAGENT_PRESET_NAME_MAX_CHARS ||
      typeof value.connectionSlug !== "string" ||
      value.connectionSlug.trim().length < 1 ||
      value.connectionSlug.trim().length > 128 ||
      typeof value.model !== "string" ||
      value.model.trim().length < 1 ||
      value.model.trim().length > 512 ||
      (value.enabled !== true && value.enabled !== false) ||
      (value.thinkingLevel !== undefined &&
        !(
          typeof value.thinkingLevel === "string" &&
          (SUBAGENT_THINKING_LEVELS as readonly string[]).includes(value.thinkingLevel)
        ))
    ) {
      continue;
    }
    const id = value.id;
    seen.add(id);
    presets.push({
      id,
      name: value.name.trim(),
      description:
        typeof value.description === "string"
          ? value.description.trim().slice(0, SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS)
          : "",
      profile: value.profile as SubagentProfile,
      connectionSlug: value.connectionSlug.trim(),
      model: value.model.trim(),
      ...(value.thinkingLevel !== undefined
        ? { thinkingLevel: value.thinkingLevel as SubagentThinkingLevel }
        : {}),
      enabled: value.enabled,
    });
  }
  return { presets };
}
