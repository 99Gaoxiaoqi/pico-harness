import { Stack } from "expo-router/stack";
import { mobileTheme } from "../lib/mobile-theme";

export default function RootLayout() {
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: mobileTheme.colors.canvas },
        headerBackButtonDisplayMode: "minimal",
        headerLargeTitle: false,
        headerShadowVisible: false,
        headerStyle: { backgroundColor: mobileTheme.colors.canvas },
        headerTintColor: mobileTheme.colors.ink,
        headerTitleStyle: {
          color: mobileTheme.colors.ink,
          fontSize: mobileTheme.type.body,
          fontWeight: "600",
        },
      }}
    />
  );
}
