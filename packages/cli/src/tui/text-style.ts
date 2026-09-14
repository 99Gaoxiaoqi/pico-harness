import type { TextProps } from "ink";

/** Omit an absent foreground so Ink preserves the enclosing text color. */
export function optionalTextColor(color: TextProps["color"]): Pick<TextProps, "color"> {
  return color === undefined ? {} : { color };
}
