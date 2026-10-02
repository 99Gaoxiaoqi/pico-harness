import React, { useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
export const color = {
  bg: "#10141c",
  panel: "#1a2130",
  line: "#2b3547",
  text: "#edf2fa",
  muted: "#96a4bc",
  accent: "#91dfbd",
  danger: "#ffa6a6",
};
export const s = StyleSheet.create({
  page: { flex: 1, backgroundColor: color.bg },
  body: { padding: 18, gap: 14 },
  row: { flexDirection: "row", gap: 10, alignItems: "center", flexWrap: "wrap" },
  card: {
    backgroundColor: color.panel,
    borderRadius: 16,
    padding: 16,
    gap: 10,
    borderWidth: 1,
    borderColor: color.line,
  },
  title: { color: color.text, fontSize: 24, fontWeight: "700" },
  text: { color: color.text, fontSize: 15, lineHeight: 23 },
  muted: { color: color.muted, fontSize: 13, lineHeight: 20 },
  input: {
    backgroundColor: color.bg,
    color: color.text,
    borderColor: color.line,
    borderWidth: 1,
    borderRadius: 10,
    padding: 12,
    minHeight: 46,
  },
  button: {
    backgroundColor: color.accent,
    paddingVertical: 11,
    paddingHorizontal: 15,
    borderRadius: 10,
  },
  buttonText: { color: color.bg, fontWeight: "700" },
  mono: { fontFamily: "monospace", color: color.muted, fontSize: 12, lineHeight: 18 },
});
export function Label({ children }: { children: React.ReactNode }) {
  return <Text style={s.muted}>{children}</Text>;
}
export function Card({ children }: { children: React.ReactNode }) {
  return <View style={s.card}>{children}</View>;
}
export function Button({
  title,
  onPress,
  reason,
  secondary = false,
}: {
  title: string;
  onPress: () => void;
  reason?: string;
  secondary?: boolean;
}) {
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ disabled: !!reason }}
        disabled={!!reason}
        onPress={onPress}
        style={[
          s.button,
          secondary && { backgroundColor: color.line },
          reason && { opacity: 0.45 },
        ]}
      >
        <Text style={[s.buttonText, secondary && { color: color.text }]}>{title}</Text>
      </Pressable>
      {reason && <Label>{reason}</Label>}
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
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  secret?: boolean;
  multiline?: boolean;
  placeholder?: string;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Label>{label}</Label>
      <TextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChange}
        secureTextEntry={secret}
        autoCorrect={false}
        autoCapitalize="none"
        multiline={multiline}
        placeholder={placeholder}
        placeholderTextColor={color.muted}
        style={[s.input, multiline && { minHeight: 90, textAlignVertical: "top" }]}
      />
    </View>
  );
}
export function Detail({ value, title = "详细信息" }: { value: unknown; title?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <View>
      <Pressable onPress={() => setOpen(!open)}>
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
}: {
  values: readonly T[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      <View style={s.row}>
        {values.map((x) => (
          <Pressable
            key={x}
            onPress={() => onChange(x)}
            style={[s.button, { backgroundColor: x === value ? color.accent : color.panel }]}
          >
            <Text style={{ color: x === value ? color.bg : color.muted }}>{x}</Text>
          </Pressable>
        ))}
      </View>
    </ScrollView>
  );
}
