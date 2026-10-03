import React from "react";
import { Linking, Share, Text, View } from "react-native";
import { usePico } from "./store";
import { Button, Card, Label, s } from "./ui";
import { releaseInfo, safeDiagnostic } from "./release-info";

export function PrivacySupport() {
  const pico = usePico();
  const diagnostic = safeDiagnostic(pico.phase, pico.errorInfo?.code);
  return (
    <View style={{ gap: 12 }}>
      <Card>
        <Text style={s.text}>隐私与数据说明</Text>
        <Label>
          手机通过 HTTPS/WSS
          直接连接你授权的电脑。会话、正式成果、任务与配置保存在电脑；电脑可能把输入、图片和必要上下文发往你配置的模型与工具服务，其处理规则由对应服务决定。
        </Label>
        <Label>
          手机在系统安全存储中保存设备令牌和待确认配对秘密；电脑地址与设备标识保存在本机普通存储。草稿文字、图片和发送／审阅恢复记录也保存在手机本机；下载成果保存在手机缓存中。未发送草稿不会自动发往模型服务。
        </Label>
        <Label>
          相机用于扫码配对和拍照；图库用于选图；无需麦克风。只有你主动选图、拍照或提交内容时才使用对应功能。本应用不提供云同步、自动备份或后台推送。
        </Label>
        <Label>
          “清除这台电脑的本机数据”删除该电脑的草稿、图片、恢复记录与可归属的成果缓存，并保留正式设备凭据。解除配对同时删除本机凭据、尝试撤销电脑授权；离线时撤销需要在电脑核对。旧版无法辨认归属的缓存须单独清空。
        </Label>
        <Label>
          清理手机数据不会删除电脑会话、取消任务、停止终端或删除模型服务已处理的内容。系统备份及卸载后的保留行为由系统决定；需要彻底解除授权时，请在电脑撤销设备。
        </Label>
        {releaseInfo.privacyPolicyUrl ? (
          <Button
            title="打开隐私政策"
            secondary
            onPress={() => void pico.perform(() => Linking.openURL(releaseInfo.privacyPolicyUrl))}
          />
        ) : (
          <Label>公开隐私政策地址尚未配置；本说明可离线阅读，当前候选用于内部验证。</Label>
        )}
      </Card>
      <Card>
        <Text style={s.text}>版本与支持</Text>
        <Label>
          Pico {releaseInfo.version} · 构建 {releaseInfo.build}
        </Label>
        <Label>发布主体：{releaseInfo.publisher || "尚未配置"}</Label>
        {releaseInfo.supportUrl && (
          <Button
            title="打开支持页面"
            secondary
            onPress={() => void pico.perform(() => Linking.openURL(releaseInfo.supportUrl))}
          />
        )}
        {releaseInfo.supportEmail && (
          <Button
            title="联系支持邮箱"
            secondary
            onPress={() =>
              void pico.perform(() =>
                Linking.openURL(`mailto:${encodeURIComponent(releaseInfo.supportEmail)}`),
              )
            }
          />
        )}
        {!releaseInfo.supportUrl && !releaseInfo.supportEmail && (
          <Label>支持地址尚未配置。可保存下面的安全诊断，再通过你现有的反馈渠道提交。</Label>
        )}
        <Text selectable style={s.mono}>
          {diagnostic}
        </Text>
        <Button
          title="分享安全诊断"
          secondary
          onPress={() => void pico.perform(() => Share.share({ message: diagnostic }))}
        />
        <Label>
          诊断仅包含版本、系统平台、连接阶段与错误码，不含地址、路径、令牌、配对内容、正文或秘密配置。
        </Label>
      </Card>
    </View>
  );
}
