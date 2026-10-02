import React from "react";
import { Pressable, Text, View } from "react-native";
import { color, Label, s } from "../ui";

export function SettingsRow({
  title,
  description,
  onPress,
  reason,
}: {
  title: string;
  description?: string;
  onPress: () => void;
  reason?: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      accessibilityHint={reason ?? description}
      accessibilityState={{ disabled: !!reason }}
      disabled={!!reason}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: 56,
        paddingVertical: 12,
        paddingHorizontal: 14,
        borderBottomWidth: 1,
        borderBottomColor: color.line,
        opacity: reason ? 0.5 : 1,
        backgroundColor: pressed ? color.surface : color.bg,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
      })}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.text}>{title}</Text>
        {(reason || description) && <Label>{reason ?? description}</Label>}
      </View>
      <Text style={{ color: color.muted, fontSize: 22 }}>›</Text>
    </Pressable>
  );
}
export function Choices<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
}: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <View style={{ gap: 6 }}>
      <Label>{label}</Label>
      {options.map((option) => (
        <Pressable
          key={option.value}
          accessibilityRole="radio"
          accessibilityLabel={option.label}
          accessibilityState={{ checked: value === option.value, disabled }}
          disabled={disabled}
          onPress={() => onChange(option.value)}
          style={({ pressed }) => ({
            minHeight: 44,
            paddingVertical: 10,
            paddingHorizontal: 12,
            borderRadius: 7,
            borderWidth: 1,
            borderColor: value === option.value ? color.accent : color.line,
            backgroundColor:
              value === option.value ? color.accentSoft : pressed ? color.surface : color.bg,
            opacity: disabled ? 0.5 : 1,
          })}
        >
          <Text style={s.text}>
            {value === option.value ? "●" : "○"} {option.label}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}
