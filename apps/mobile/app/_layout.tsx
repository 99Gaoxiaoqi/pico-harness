import { Stack } from "expo-router";
import { PicoProvider } from "../src/store";
export default function Layout() {
  return (
    <PicoProvider>
      <Stack screenOptions={{ headerShown: false }} />
    </PicoProvider>
  );
}
