import type { ProfileName } from "../config.js";

/**
 * What each chat is allowed to see. The LLM is only ever handed the tools a
 * profile can call — permissions are structural, not prompt-level.
 */
export const PROFILE_PERMISSIONS: Readonly<Record<ProfileName, readonly string[]>> = {
  romi: ["turnos.*", "pagos.*", "stock.*"],
  mateo: ["*"],
};

export type ChatAllowlist = Readonly<Record<string, ProfileName>>;

/** The profile bound to a chat, or `undefined` when the chat is not allow-listed. */
export function resolveProfile(
  allowlist: ChatAllowlist,
  chatId: number | string,
): ProfileName | undefined {
  return allowlist[String(chatId)];
}

export function toolPermissionsFor(profile: ProfileName): readonly string[] {
  return PROFILE_PERMISSIONS[profile];
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\\\*/g, ".*")}$`);
}

/** True when `toolName` (e.g. `turnos.del_dia`) matches one of the profile patterns. */
export function isToolAllowed(profile: ProfileName, toolName: string): boolean {
  return toolPermissionsFor(profile).some((pattern) => globToRegExp(pattern).test(toolName));
}
