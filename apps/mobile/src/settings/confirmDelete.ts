import { Alert } from "react-native";

export function confirmDelete(name: string, action: () => void) {
  Alert.alert(`删除 ${name}？`, "此操作会修改电脑上的数据。", [
    { text: "返回" },
    { text: "删除", style: "destructive", onPress: action },
  ]);
}
