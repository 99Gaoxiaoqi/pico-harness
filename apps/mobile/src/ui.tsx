import React, { useState } from "react";
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { color } from "./palette";
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Metro 静态图片资源需要使用字面量 require。
const brandIcon = require("../assets/brand-icon.png");
export { color } from "./palette";
export const switchColors = {
  trackColor: { false: color.lineStrong, true: color.accent },
  thumbColor: color.bg,
  ios_backgroundColor: color.lineStrong,
};
export const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.bg },
  body: { padding: 16, gap: 12 },
  row: { flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" },
  card: {
    backgroundColor: color.panel,
    borderRadius: 11,
    padding: 14,
    gap: 10,
    borderWidth: 1,
    borderColor: color.line,
  },
  title: { color: color.text, fontSize: 20, fontWeight: "600" },
  text: { color: color.text, fontSize: 15, lineHeight: 23 },
  muted: { color: color.muted, fontSize: 13, lineHeight: 20 },
  input: {
    backgroundColor: color.bg,
    color: color.text,
    borderColor: color.line,
    borderWidth: 1,
    borderRadius: 7,
    paddingHorizontal: 12,
    paddingVertical: 10,
    minHeight: 46,
  },
  button: {
    backgroundColor: color.accent,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderColor: color.accent,
    borderRadius: 7,
  },
  buttonText: { color: color.bg, fontSize: 14, fontWeight: "600" },
  mono: {
    fontFamily: Platform.OS === "ios" ? "Menlo" : "monospace",
    color: color.muted,
    fontSize: 12,
    lineHeight: 18,
  },
  chips: {
    flexDirection: "row",
    gap: 4,
    padding: 3,
    borderRadius: 9,
    backgroundColor: color.surface,
  },
});
export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={s.muted}>{children}</Text>;
}
export function BrandMark({ size = 28 }: { size?: number }) {
  return (
    <Image
      source={brandIcon}
      style={{ width: size, height: size }}
      resizeMode="contain"
      accessibilityRole="image"
      accessibilityLabel="Pico"
    />
  );
}
export function Card({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return <View style={[s.card, style]}>{children}</View>;
}
export function Button({
  title,
  onPress,
  reason,
  secondary = false,
  quiet = false,
  reasonDetail = true,
}: {
  title: string;
  onPress: () => void;
  reason?: string;
  secondary?: boolean;
  quiet?: boolean;
  reasonDetail?: boolean;
}) {
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !!reason }}
        accessibilityHint={reason}
        disabled={!!reason}
        onPress={onPress}
        style={({ pressed }) => [
          s.button,
          secondary && { backgroundColor: color.bg, borderColor: color.line },
          quiet && { backgroundColor: "transparent", borderColor: "transparent" },
          pressed && {
            backgroundColor: secondary || quiet ? color.surface : color.accentStrong,
          },
          reason && { opacity: 0.5 },
        ]}
      >
        <Text
          style={[
            s.buttonText,
            secondary && { color: color.text },
            quiet && { color: color.muted },
          ]}
        >
          {title}
        </Text>
      </Pressable>
      {reason && reasonDetail && <Label>{reason}</Label>}
    </View>
  );
}
export function Field({
  label,
  value,
  onChange,
  secret = false,
  multiline = false,
  placeholder,
  compact = false,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
  multiline?: boolean;
  placeholder?: string;
  compact?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: 6 }}>
      {!compact && <Label>{label}</Label>}
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secret}
        autoCorrect={false}
        autoCapitalize="none"
        multiline={multiline}
        placeholder={placeholder ?? (compact ? label : undefined)}
        placeholderTextColor={color.muted}
        selectionColor={Platform.OS === "android" ? color.accentSoft : color.focus}
        cursorColor={color.focus}
        selectionHandleColor={color.focus}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={[
          s.input,
          multiline && { minHeight: compact ? 54 : 90, textAlignVertical: "top" },
          focused && { borderColor: color.focus },
        ]}
      />
    </View>
  );
}
export function Detail({ value, title = "详细信息" }: { value: unknown; title?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text style={{ color: color.accent, paddingVertical: 7 }}>
          {open ? "▾" : "▸"} {title}
        </Text>
      </Pressable>
      {open && (
        <Text selectable style={s.mono}>
          {JSON.stringify(value, null, 2)}
        </Text>
      )}
    </View>
  );
}
export function Busy({ label = "正在同步" }: { label?: string }) {
  return (
    <View style={s.row}>
      <ActivityIndicator color={color.accent} />
      <Label>{label}</Label>
    </View>
  );
}
export function Chips<T extends string>({
  values,
  value,
  onChange,
  labels,
  disabled = false,
}: {
  values: readonly T[];
  value: T;
  onChange: (v: T) => void;
  labels?: Partial<Record<T, string>>;
  disabled?: boolean;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={s.chips}>
        {values.map((x) => (
          <Pressable
            key={x}
            accessibilityRole="tab"
            accessibilityState={{ selected: x === value, disabled }}
            disabled={disabled}
            onPress={() => onChange(x)}
            style={({ pressed }) => [
              s.button,
              {
                backgroundColor: x === value ? color.bg : pressed ? color.line : "transparent",
                borderColor: x === value ? color.line : "transparent",
              },
            ]}
          >
            <Text
              style={{
                color: x === value ? color.text : color.muted,
                fontSize: 13,
                fontWeight: x === value ? "600" : "400",
              }}
            >
              {labels?.[x] ?? x}
            </Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}
