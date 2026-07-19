import { Stack } from "expo-router";
import { ScrollView, Text, View } from "react-native";

export default function ProjectsScreen() {
  return (
    <>
      <Stack.Screen options={{ title: "项目" }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ flexGrow: 1, justifyContent: "center", padding: 24 }}
      >
        <View style={{ alignItems: "center", gap: 8 }}>
          <Text selectable style={{ fontSize: 24, fontWeight: "700" }}>
            Pico Mobile
          </Text>
          <Text selectable style={{ color: "#6B6B70", fontSize: 16, textAlign: "center" }}>
            已完成 iOS 与 Android 共用工程初始化。
          </Text>
        </View>
      </ScrollView>
    </>
  );
}
