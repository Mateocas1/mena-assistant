import { describe, expect, it } from "vitest";
import { parseCallbackData, proposalKeyboard, proposalMessage } from "../src/bot/index.js";

describe("Telegram callback payloads", () => {
  it("parses confirm and cancel payloads", () => {
    expect(parseCallbackData("confirm:prop_1")).toEqual({
      action: "confirm",
      proposalId: "prop_1",
    });
    expect(parseCallbackData("cancel:prop_1")).toEqual({ action: "cancel", proposalId: "prop_1" });
    expect(parseCallbackData("confirm:")).toBeUndefined();
    expect(parseCallbackData("delete:prop_1")).toBeUndefined();
    expect(parseCallbackData("prop_1")).toBeUndefined();
  });

  it("builds a Confirm/Cancel keyboard carrying the proposal id", () => {
    const keyboard = proposalKeyboard("prop_1");
    const row = keyboard.inline_keyboard[0] ?? [];
    const payloads = row.map((button) =>
      "callback_data" in button ? button.callback_data : undefined,
    );
    expect(payloads).toEqual(["confirm:prop_1", "cancel:prop_1"]);
    expect(row.map((button) => button.text)).toEqual(["✅ Confirmar", "❌ Cancelar"]);
  });

  it("shows the human summary and the diff in the proposal message", () => {
    const text = proposalMessage("Cancelar el turno apt_1", "- confirmed\n+ cancelled");
    expect(text).toContain("Cancelar el turno apt_1");
    expect(text).toContain("+ cancelled");
  });
});
