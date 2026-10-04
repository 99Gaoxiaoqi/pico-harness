# Relay 服务部署

`@pico/remote-relay` 是独立 Node + `ws` 服务。电脑和手机主动连接同一个 WSS 入口；服务按 `gatewayId/channelId` 转发不透明字符串，不解析手机与电脑间的 E2EE 内容，也不访问本机 Runtime。

个人部署在初始化时预先绑定电脑，普通远程设置不需要一次性邀请。服务接入 token 用于证明电脑可占用对应 `gatewayId`，与手机配对的 `deviceToken` 不同。长期接入 token 由电脑生成并先保存；预绑定只提交 SHA-256。不要把 token、配对秘密、E2EE 私钥或旧版邀请写入 URL、部署文件和日志。

## 构建与本机运行

从仓库根目录运行：

```sh
npm run build --workspace @pico/remote-relay
node packages/remote-relay/dist/cli.js serve --home "$HOME/.pico-relay" --port 8787
```

默认只监听 `127.0.0.1`。HTTP/WS 仅用于本机开发或受隔离的反代内网；正式手机和电脑客户端连接 `https://` / `wss://` 公网入口并验证证书。Node 接口 `startRelayServer({home, port, tls:{cert,key}})` 也可直接提供 HTTPS/WSS，集成测试使用本地测试 CA，并未禁用证书校验。

`--allow-private-bind` 才允许监听其他地址。`--trust-proxy` 只应在反代到服务的入口被防火墙或独立容器网络隔离时使用：服务信任反代写入的单个 `X-Forwarded-For` IP，用于限额；不能把启用该选项的上游端口直接暴露公网。

## Caddy 容器部署

部署目标是拥有 DNS 名称和入站 80/443 的 Linux 服务器。为 `RELAY_DOMAIN` 设置 A/AAAA 记录，指向这台服务器；若发布 AAAA，IPv6 的 80/443 也必须可达。此服务器接收入站连接，运行 Pico 的电脑无需公网入口或路由器端口映射。

```sh
export RELAY_DOMAIN=relay.example.com
docker compose -f deploy/relay/compose.yaml up -d --build
```

替换示例域名为实际域名。Caddy 自动申请并续期公网证书；服务的 8787 端口没有发布到宿主机，只有隔离网络中的 Caddy 能访问。Caddy 覆盖客户端提交的 `X-Forwarded-For`，且配置未启用访问日志。不要增加记录请求体、WebSocket 内容或认证帧的日志。

容器以非 root 用户运行，状态写入 `relay_state` 私有卷；该卷含管理员认证材料，应只向运维账号开放。应用根文件系统只读。当前镜像使用 Node 26 与 Caddy 2 大版本标签；生产环境应在完成验证后固定镜像摘要，升级时重新验证。

## 个人部署初始化与撤销

先在准备远程访问的电脑上运行：

```sh
pico remote relay prepare --url https://relay.example.com
```

命令只在电脑本机生成并持久化接入凭据与加密密钥，输出 `{version:1,relayUrl,gatewayId,tokenHash}`；不发起公网登记，也不输出 token 明文或私钥。普通重复运行会保留原 token，便于重跑部署。

然后在 Relay 服务器上绑定输出中的 `gatewayId` 和 `tokenHash`。服务必须正在运行。CLI 通过状态目录里的私有 `admin.sock`（Windows 为命名管道）操作；没有公开 HTTP 绑定或管理员接口。

```sh
docker compose -f deploy/relay/compose.yaml exec relay node dist/cli.js bind --home /data --gateway YOUR_GATEWAY_ID --token-hash YOUR_TOKEN_HASH
```

直接运行 Node 服务时，对应命令是 `pico-relay bind --gateway ID --token-hash HASH [--home PATH]`（仓库内也可使用 `node packages/remote-relay/dist/cli.js bind ...`）。成功返回 `{version:1,bound:true}`。相同有效 ID/hash 可以幂等重跑；已有效的 ID 不能被另一个 hash 覆盖。

绑定成功后，在电脑远程设置中保存同一个 Relay URL，授权项目并开启远程访问。手机扫码时仍需电脑本机审批；Relay 绑定不会代替手机配对审批，也不会开放无认证公网注册。

需要撤销电脑接入时，在服务器运行：

```sh
docker compose -f deploy/relay/compose.yaml exec relay node dist/cli.js revoke --home /data --gateway YOUR_GATEWAY_ID
```

`revoke` 先持久化撤销，再立即关闭该电脑及其全部手机连接。使用旧 hash 再次 `bind` 会返回 `HOST_REVOKED`，重跑旧部署不能撤销这个操作。需要恢复时，先在电脑关闭远程访问，显式运行 `pico remote relay prepare --url https://relay.example.com --rotate` 生成新 token，再把新的 `tokenHash` 在服务器本地 `bind`，最后重新开启电脑远程访问。

旧版 `pico-relay invite [--home PATH] [--ttl SECONDS]` 与邀请登记流程保留兼容：邀请默认十分钟有效，允许一秒至二十四小时；邀请属于秘密。个人部署使用上面的预绑定流程即可。

## 协议与恢复边界

所有 WebSocket 帧都包含 `version:1`，非 JSON 文本、未知字段、缺失版本或不合法角色消息会被拒绝。

- 首帧为电脑 `{version:1,type:"host",gatewayId,token}`，或手机 `{version:1,type:"join",gatewayId}`。
- 电脑收到 `registered`；手机收到带 `channelId` 的 `joined`，电脑收到相同 channel 的 `open`。端点的 E2EE 握手在 `data.payload` 内进行。
- 手机 `data` 由服务附加 channel 转电脑；电脑 `data` 必须指定自己名下的 channel，服务转手机时去掉 channel。字符串 payload 原样传递。
- `close` 可带大写字符串 `code`，例如 `HOST_DISCONNECTED`；错误帧为 `{version:1,type:"error",code}`。服务不透出令牌或内部异常详情。
- 不抢占在线电脑。电脑掉线即关闭其全部手机通道；不存在离线命令队列。重连后端点重新建立通道和加密会话，业务层负责安全同步，不能依赖 Relay 自动重放命令。

个人预绑定只接受私有管理方法 `bind`，参数精确为 `{gatewayId,tokenHash}`，不接受 token 明文或多余字段。已撤销的记录只能以新 hash 重新绑定。

兼容旧客户端的登记接口为 `POST /v1/enroll`，请求 `{version:1,invitation,gatewayId,tokenHash}`，成功返回 `{version:1,enrolled:true}`，仍要求有效邀请。同一邀请绑定后，仅相同三元组可幂等重试，解决响应丢失；改变 gateway 或 token hash 会被拒绝。已成功绑定的重试不受邀请过期影响，但仍必须对应未撤销的电脑记录。

状态 `state.json` 仅保存 invitation hash、到期/绑定与 host token hash，写入经单一串行队列、私有临时文件和原子 rename。CLI 不绕开这个队列写文件，避免预绑定、邀请、登记和撤销并发丢更新。POSIX 状态目录为 `0700`、JSON 为 `0600`，拒绝符号链接与非当前用户所有的状态；部署与权限验收以 Linux/POSIX 为目标，Windows ACL 未在本轮验收。

## 默认限额

物理 JSON 帧上限 `2 MiB + 64 KiB`，payload UTF-8 上限为物理预算减 `2048` 字节，保留路由信封空间并容纳最大业务请求的十六进制密文。JSON 转义后的物理大小仍须符合预算；不启用 WebSocket 压缩。默认最多 1024 连接、每 IP 32 连接、128 在线电脑、每电脑 64 手机通道；全部 joined 通道都计数，Relay 无法识别不透明握手是否已经认证。

首帧期限五秒；每 IP 每分钟 60 次连接升级、60 个注册首帧和 10 次邀请登记。注册首帧另有每 IP `64 KiB/min` 的字节配额。注册成功后帧和字节配额按通道及电脑计费，同一 NAT 出口的电脑和手机不共享应用帧桶：

| Node `limits` 参数      | 默认值     | 计费范围                   |
| ----------------------- | ---------- | -------------------------- |
| `framesPerMinute`       | 6000/min   | 每手机通道，上下行合计     |
| `bytesPerMinute`        | 32 MiB/min | 每手机通道，上下行合计     |
| `hostFramesPerMinute`   | 60000/min  | 每电脑，所有通道上下行聚合 |
| `hostBytesPerMinute`    | 1 GiB/min  | 每电脑，所有通道上下行聚合 |
| `pendingBytesPerMinute` | 64 KiB/min | 每 IP，注册前首帧          |

上述配额是按一分钟容量、连续补充的 token bucket，允许最多一桶突发。字节成本为实际接收到的 UTF-8 JSON 物理帧，包含密文十六进制膨胀和信封；手机上行也计入电脑聚合预算。电脑给某个超额通道发送时，仅关闭该通道，其他通道继续工作；电脑自己耗尽聚合预算则断开电脑及全部通道。手机上行耗尽电脑聚合预算时，关闭发送方。默认帧预算可容纳 64 个通道每 80ms 一帧的会话增量，字节预算仍限制大帧持续流量。

每发送目标最大积压约四个物理帧。30 秒检查原生 ping/pong，失去响应或十五分钟没有应用活动/客户端 ping 会关闭连接。上限可通过 Node `limits` 参数调整，所有值须为正整数。

邀请与电脑记录分别最多一万条；已绑定邀请保留以保障重试语义。服务不持久化密文、会话消息、文件、手机凭据或业务操作结果。`GET /v1/health` 只返回非敏感版本与运行状态。

## 验证与回退

```sh
npm run typecheck --workspace @pico/remote-relay
node --import tsx --test tests/integration/remote/relay-service.integration.test.ts
```

测试通过私有 CLI 和真实 HTTPS/WSS 验证预绑定、精确字段校验、幂等重跑、拒绝覆盖有效凭据、撤销后旧凭据拒绝恢复与新 token 重绑定；也覆盖旧版邀请重试和重启恢复、双向不透明转发、多租户隔离、错误 token、版本限制、通道限额、在线撤销与电脑掉线无缓存。同出口多通道超 300 帧转发以及双向帧、UTF-8 字节和电脑聚合预算也有回归覆盖。服务本身没有 E2EE 密码学实现；密码学与业务权限需由手机/电脑端的集成测试另行验收。

升级前停止 Relay 服务并备份 `relay_state`，记录当前镜像摘要；保留 Caddy 证书卷。回退恢复旧镜像及与其状态版本相容的备份，重新启动。停服会断开远程通道，但 Relay 不向电脑发送取消任务命令。不要在运行中复制状态后声称它是已确认的一致备份。
