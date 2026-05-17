import React from "react";
import { Box, Text } from "ink";
import { PasswordInput, TextInput } from "@inkjs/ui";
import type { CodexCliStatus, CodexRunPolicy } from "../../codex/codex-cli.js";
import { formatCodexCommandSource, formatCodexPlatform } from "../../codex/codex-process.js";
import type { ChannelInstanceRecord, PendingBindingRecord } from "../../state/persistent-state-types.js";
import { chatCodexTitle } from "../../runtime/package-info.js";
import type { BindingSummary, SessionChoices } from "../actions/binding-actions.js";
import { formatSessionActiveTime } from "../actions/binding-actions.js";
import { channelDisplayName, formatFullDateTime, formatManagedChannelLabel, formatShortDateTime } from "../actions/channel-actions.js";
import type { LauncherDashboard, PairingDashboardSummary, PairingRouteSummary, StartValidation } from "../actions/launcher-actions.js";
import { formatChannelStatusDetails } from "../serve-wizard.js";
import type { PermissionTarget, Screen, SessionTarget } from "./types.js";
import {
  channelStatus,
  formatPermission,
  formatSession,
  formatSessionWithActivity,
  Frame,
  KeyValue,
  ListRow,
  Muted,
  ScrollHint,
  Section,
  SessionRow,
  statusColor,
  THEME,
  truncate,
  useViewportRows,
  visibleWindow,
} from "./ui-components.js";

export function HomeView({ dashboard, selected }: { dashboard: LauncherDashboard; selected: number }): React.JSX.Element {
  if (dashboard.channels.length === 0) {
    const actions = [
      ["1. 添加微信账号", "扫码登录后配置微信主聊天绑定"],
      ["2. 添加飞书机器人", "输入 App ID / App Secret，启动后等待私聊"],
      ["3. 权限设置", formatPermission(dashboard.startup.policy)],
      ["4. 工作目录", dashboard.startup.cwd],
      ["0. 退出", "返回终端"],
    ];
    return (
      <Frame title={chatCodexTitle()} subtitle="首次配置">
        <Section title="欢迎使用 Chat Codex">
          <Text>还没有配置任何渠道。请先添加微信账号或飞书机器人。</Text>
        </Section>
        <Section title="默认配置">
          <CodexCliStatusBlock status={dashboard.startup.codexStatus} />
          <KeyValue label="新 session 工作目录" value={dashboard.startup.cwd} />
          <KeyValue label="新 session 权限" value={formatPermission(dashboard.startup.policy)} />
        </Section>
        <Section title="操作">
          {actions.map(([label, value], index) => <ListRow key={label} active={selected === index} left={label} right={value} />)}
        </Section>
        <Section title="快捷键">
          <Text>↑↓ 选择  Enter 执行  1/w 微信  2/f 飞书  3/p 权限  4/d 工作目录  q 退出</Text>
        </Section>
      </Frame>
    );
  }
  const rows = [
    ["1. 管理渠道", `${dashboard.channels.length} 个渠道`],
    ["2. 聊天绑定", `${dashboard.routes.bound}/${dashboard.routes.known} 已绑定，${dashboard.routes.pending ?? 0} 个待生效`],
    ["3. 配对管理", `${dashboard.pairing.trusted} 个已配对，${dashboard.pairing.pending} 个待配对`],
    ["4. 权限设置", formatPermission(dashboard.startup.policy)],
    ["5. 工作目录", dashboard.startup.cwd],
    ["6. 状态详情", "查看渠道和绑定明细"],
    ["7. 启动服务", dashboard.canStart.ok ? "启动并进入运行日志" : "需处理配置"],
  ];
  return (
    <Frame title={chatCodexTitle()} subtitle={`状态: ${dashboard.canStart.ok ? "可启动" : "需配置"}  权限: ${dashboard.startup.policy.permissionMode === "full" ? "完全" : "审批"}`} borderColor={dashboard.canStart.ok ? THEME.success : THEME.warning}>
      <Section title="启动服务">
        <Text color={dashboard.canStart.ok ? THEME.success : THEME.warning} bold>
          {dashboard.canStart.ok ? "▶ 已准备好。按 Enter 启动 Bridge，并进入运行日志面板。" : `⚠ ${dashboard.canStart.message}`}
        </Text>
        <KeyValue label="启动后" value="显示运行中状态、已启动渠道、工作目录和 Ctrl+C 停止方式" />
      </Section>
      <Section title="Codex CLI">
        <CodexCliStatusBlock status={dashboard.startup.codexStatus} />
      </Section>
      <Section title="操作">
        {rows.map(([label, value], index) => (
          <ListRow
            key={label}
            active={selected === index}
            left={label}
            right={value}
            tone={index === 6 ? (dashboard.canStart.ok ? "success" : "warning") : undefined}
          />
        ))}
      </Section>
      <Section title="渠道">
        {dashboard.channels.length === 0
          ? <Muted text="暂无渠道。按 w 添加微信账号，或按 f 添加飞书机器人。" />
          : dashboard.channels.map((channel) => (
            <Text key={channel.record.id}>
              {formatManagedChannelLabel(channel)}    {channel.record.enabled ? "已启用" : "已停用"}    <Text color={statusColor(channel.status.state)}>{channelStatus(channel.status.state)}</Text>    添加 {formatShortDateTime(channel.record.createdAt)}
            </Text>
          ))}
      </Section>
      <Section title="聊天绑定">
        <Text>已发现 {dashboard.routes.known} 个聊天，已绑定 {dashboard.routes.bound} 个 session，待生效 {dashboard.routes.pending ?? 0} 个。</Text>
      </Section>
      <Section title="配对信任">
        <Text>已信任 {dashboard.pairing.trusted} 个聊天，待配对 {dashboard.pairing.pending} 个聊天。</Text>
      </Section>
      <Section title="工作目录">
        <KeyValue label="新 session" value={dashboard.startup.cwd} />
      </Section>
      <Section title="提示">
        <Text>{dashboard.canStart.message}</Text>
      </Section>
    </Frame>
  );
}

export function ChannelsView({ channels, selected, channelCursor = 0 }: { channels: LauncherDashboard["channels"]; selected: number; channelCursor?: number }): React.JSX.Element {
  // fixed: Frame(4) + "已配置渠道" section(3) + "操作" section(3) + 7 actions + footer(2) = 19
  const channelViewport = useViewportRows(19);
  if (channels.length === 0) {
    const actions = [
      ["1. 添加微信账号", "扫码登录微信"],
      ["2. 添加飞书机器人", "输入机器人凭证"],
    ];
    return (
      <Frame title="管理渠道" subtitle="Enter 执行  w 微信  f 飞书  Esc 返回">
        <Muted text="暂无渠道。请先添加微信账号或飞书机器人。" />
        <Section title="操作">
          {actions.map(([label, value], index) => <ListRow key={label} active={selected === index} left={label} right={value} />)}
        </Section>
      </Frame>
    );
  }
  const actionOffset = channels.length;
  const targetChannel = channels[Math.min(channelCursor, channels.length - 1)];
  const targetName = targetChannel ? formatManagedChannelLabel(targetChannel) : "未选择";
  const actions = [
    ["添加微信账号", "扫码登录微信"],
    ["添加飞书机器人", "输入凭证并校验连通性"],
    ["修改选中渠道备注", targetName],
    [targetChannel?.record.enabled ? "停用选中渠道" : "启用选中渠道", targetName],
    ["删除选中渠道", "移除配置、聊天记录和绑定占用"],
    ["查看选中渠道详情", targetName],
    ["返回首页", "回到启动页"],
  ];
  const channelSelected = selected < actionOffset ? selected : actionOffset - 1;
  const cw = visibleWindow(channels, channelSelected, channelViewport);
  return (
    <Frame title="管理渠道" subtitle="Enter 执行  w 微信  f 飞书  e 启停">
      <Section title="已配置渠道">
        <ScrollHint above={cw.above} below={0} />
        {cw.slice.map((channel, i) => {
          const index = cw.startIndex + i;
          return (
            <ListRow
              key={channel.record.id}
              active={selected === index}
              left={`${index + 1}. ${formatManagedChannelLabel(channel)}`}
              right={`${channel.record.enabled ? "已启用" : "已停用"}   ${channelStatus(channel.status.state)}   添加 ${formatShortDateTime(channel.record.createdAt)}`}
              tone={channel.status.state === "connected" ? "success" : channel.status.state === "failed" ? "danger" : channel.status.state === "login_required" ? "warning" : undefined}
            />
          );
        })}
        <ScrollHint above={0} below={cw.below} />
      </Section>
      <Section title="操作">
        {actions.map(([label, value], index) => (
          <ListRow
            key={label}
            active={selected === actionOffset + index}
            left={`${actionOffset + index + 1}. ${label}`}
            right={value}
            tone={label === "删除选中渠道" ? "danger" : undefined}
          />
        ))}
      </Section>
    </Frame>
  );
}

export function ChannelDetailView({ channel, selected }: { channel?: LauncherDashboard["channels"][number]; selected: number }): React.JSX.Element {
  if (!channel) return <Frame title="渠道详情"><Muted text="这个渠道已经不存在。" /></Frame>;
  const items = channel.record.type === "weixin"
    ? ["设置微信主聊天绑定", "修改备注", channel.record.enabled ? "停用这个渠道" : "启用这个渠道", "删除这个渠道", "状态详情"]
    : ["输入/更新本进程凭证", "修改备注", channel.record.enabled ? "停用这个渠道" : "启用这个渠道", "删除这个渠道", "状态详情"];
  return (
    <Frame title="渠道详情" subtitle="Enter 执行  e 启停  Esc 返回">
      <KeyValue label="类型" value={channel.record.type === "weixin" ? "微信" : "飞书"} />
      <KeyValue label="备注" value={channel.record.displayName ?? "未设置"} />
      <KeyValue label="账号标识" value={channel.status.account ?? channel.record.defaultAccountId ?? "default"} />
      <KeyValue label="实例" value={channel.record.id} />
      <KeyValue label="启用" value={channel.record.enabled ? "是" : "否"} />
      <KeyValue label="状态" value={channelStatus(channel.status.state)} />
      <KeyValue label="添加时间" value={formatFullDateTime(channel.record.createdAt)} />
      <KeyValue label="更新时间" value={formatFullDateTime(channel.record.updatedAt)} />
      {channel.status.lastError ? <KeyValue label="最近错误" value={channel.status.lastError} /> : null}
      <Section title="操作">
        {items.map((item, index) => <ListRow key={item} active={selected === index} left={`${index + 1}. ${item}`} tone={item.startsWith("删除") ? "danger" : undefined} />)}
      </Section>
    </Frame>
  );
}

export function ChannelRenameView({ channel, value, onChange, onSubmit }: { channel?: LauncherDashboard["channels"][number]; value: string; onChange(value: string): void; onSubmit(value: string): void | Promise<void> }): React.JSX.Element {
  return (
    <Frame title="修改渠道备注" subtitle="Enter 保存  Esc 返回">
      {channel ? (
        <>
          <KeyValue label="渠道" value={formatManagedChannelLabel(channel)} />
          <KeyValue label="账号标识" value={channel.status.account ?? channel.record.defaultAccountId ?? "default"} />
          <Muted text="备注只影响展示，不改变渠道实例、账号标识或聊天绑定。" />
          <Box marginTop={1}>
            <Text>备注: </Text>
            <TextInput defaultValue={value} placeholder={channelDisplayName(channel.record, channel.status)} onChange={onChange} onSubmit={onSubmit} />
          </Box>
        </>
      ) : <Muted text="这个渠道已经不存在。" />}
    </Frame>
  );
}

export function AddWeixinView({ screen, loading }: { screen: Extract<Screen, { name: "addWeixin" }>; loading: boolean }): React.JSX.Element {
  const subtitle = screen.login ? "5 秒自动检查  Enter 立即检查  Esc 返回" : loading ? "正在获取二维码  Esc 返回" : "Enter 重试  Esc 返回";
  return (
    <Frame title="添加微信账号" subtitle={subtitle}>
      {!screen.login ? <Muted text={loading ? "正在发起扫码登录..." : "二维码未显示。按 Enter 重试，或按 Esc 返回。"} /> : (
        <>
          <Text>请使用微信扫码，并在手机上确认；TUI 会每 5 秒自动检查登录结果。</Text>
          <Box marginY={1} flexDirection="column">
            {screen.login.qrCode ? screen.login.qrCode.split("\n").map((line, index) => <Text key={index}>{line}</Text>) : <Muted text="二维码渲染失败，请使用备用链接。" />}
          </Box>
          {screen.login.fallbackLink ? <Text>备用链接: {truncate(screen.login.fallbackLink, 72)}</Text> : null}
        </>
      )}
    </Frame>
  );
}

export function AddFeishuView({ screen, onSubmit }: { screen: Extract<Screen, { name: "addFeishu" }>; onSubmit(value: string): void | Promise<void> }): React.JSX.Element {
  const label = feishuStepLabel(screen.step);
  const defaultValue = defaultForFeishuStep(screen.step);
  return (
    <Frame title="添加飞书机器人" subtitle="Secret 不落盘，Esc 返回">
      <Text>请手动输入 App ID、App Secret 和账号标识；飞书域默认 feishu。</Text>
      {screen.step === "accountId" ? <Muted text="账号标识是本地名称，用来区分多个飞书机器人；不能为空。" /> : null}
      <Box marginTop={1}>
        <Text>{label}: </Text>
        {screen.step === "appSecret"
          ? <PasswordInput placeholder="输入 App Secret" onSubmit={onSubmit} />
          : <TextInput placeholder={defaultValue ? `[${defaultValue}]` : label} onSubmit={onSubmit} />}
      </Box>
    </Frame>
  );
}

export function WeixinBindingView({ channel, choices, selected }: { channel?: ChannelInstanceRecord; choices?: SessionChoices; selected: number }): React.JSX.Element {
  // fixed: Frame(4) + 2 KeyValues(2) + session section(3) + action section(6) + footer(2) = 17
  const viewportRows = useViewportRows(17);
  const selectable = choices?.selectable ?? [];
  const sw = visibleWindow(selectable, selected, viewportRows);
  const actionOffset = selectable.length;
  const actions = [
    ["n. 新建 Codex session", "推荐：收到第一条微信私聊后创建"],
    ["m. 手动输入 Session ID", "绑定已有 Codex session"],
    ["0. 暂不绑定", "首条消息自动创建"],
  ];
  return (
    <Frame title="微信主聊天绑定" subtitle="↑↓ 选择  Enter 执行  n 新建  m 手动输入  0 暂不绑定">
      {channel ? <KeyValue label="渠道实例" value={channel.id} /> : <Muted text="这个微信渠道已经不存在。" />}
      {channel?.defaultAccountId ? <KeyValue label="账号" value={channel.defaultAccountId} /> : null}
      <Section title="可选 session">
        {selectable.length ? (
          <>
            <ScrollHint above={sw.above} below={0} />
            {sw.slice.map((item, i) => <SessionRow key={item.id} index={sw.startIndex + i} active={selected === sw.startIndex + i} session={item} />)}
            <ScrollHint above={0} below={sw.below} />
          </>
        ) : <Muted text="暂无可选历史 session。" />}
      </Section>
      <Section title="直接操作">
        {actions.map(([label, value], index) => (
          <ListRow
            key={label}
            active={selected === actionOffset + index}
            left={label}
            right={value}
            tone={index === 0 ? "success" : undefined}
          />
        ))}
      </Section>
      {choices?.unavailable.length ? (
        <Section title="不可选（已绑定其他聊天）">
          {choices.unavailable.map((item) => <Text key={item.id}>已绑定到 {item.ownerLabel}    {formatSessionWithActivity(item)}</Text>)}
        </Section>
      ) : null}
    </Frame>
  );
}

export function BindingsView({ bindings, pendingBindings, selected }: { bindings: BindingSummary[]; pendingBindings: PendingBindingRecord[]; selected: number }): React.JSX.Element {
  // fixed: Frame(4) + footer(2) + padding(2) = 8
  const viewportRows = useViewportRows(8);
  const allItems = [
    ...bindings.map((b, i) => ({
      key: b.route.routeKey,
      label: `${i + 1}. ${b.label}`,
      right: b.trusted === false ? "待配对，暂不能绑定" : b.activeSession ? formatSessionWithActivity(b.activeSession) : "未绑定",
      tone: b.trusted === false ? "warning" as const : undefined,
    })),
    ...pendingBindings.map((p, i) => ({
      key: p.id,
      label: `${bindings.length + i + 1}. ${p.label ?? p.id}`,
      right: p.binding.type === "existing" ? `待生效: ${p.binding.sessionId.slice(0, 8)}` : "待生效: 新 session",
      tone: undefined,
    })),
  ];
  const bw = visibleWindow(allItems, selected, viewportRows);
  return (
    <Frame title="聊天绑定" subtitle="Enter 详情  n 新建  m 手动绑定  u 解绑  p 权限">
      {allItems.length === 0
        ? <Muted text="还没有发现任何聊天。启动服务后，微信私聊或飞书用户私聊机器人会自动记录在这里。" />
        : (
          <>
            <ScrollHint above={bw.above} below={0} />
            {bw.slice.map((item, i) => (
              <ListRow key={item.key} active={selected === bw.startIndex + i} left={item.label} right={item.right} tone={item.tone} />
            ))}
            <ScrollHint above={0} below={bw.below} />
          </>
        )}
    </Frame>
  );
}

export function BindingDetailView({ binding, selected }: { binding?: BindingSummary; selected: number }): React.JSX.Element {
  if (!binding) return <Frame title="绑定详情"><Muted text="这个聊天记录已经不存在。" /></Frame>;
  if (binding.trusted === false) {
    return (
      <Frame title="绑定详情" subtitle="Enter 前往配对详情  Esc 返回" borderColor={THEME.warning}>
        <KeyValue label="聊天" value={binding.label} />
        <KeyValue label="配对状态" value="待配对" />
        <KeyValue label="当前 session" value={binding.activeSession ? formatSession(binding.activeSession) : "未绑定"} />
        <Section title="说明">
          <Muted text="这个聊天还没有完成 Chat-Codex 配对，暂不能绑定、切换或新建 session。" />
        </Section>
        <Section title="操作">
          <ListRow active={selected === 0} left="1. 前往配对详情" right="本机确认信任或等待聊天发送配对码" tone="warning" />
          <ListRow active={selected === 1} left="2. 返回" />
        </Section>
      </Frame>
    );
  }
  const items = [
    "选择已有 session",
    "新建并绑定 session",
    binding.activeSession ? "设置当前 session 权限" : "设置当前 session 权限（请先绑定 session）",
    binding.activeSession ? "解绑当前 session" : "解绑当前 session（当前未绑定）",
  ];
  return (
    <Frame title="绑定详情" subtitle="Enter 执行  Esc 返回">
      <KeyValue label="聊天" value={binding.label} />
      <KeyValue label="当前 session" value={binding.activeSession ? formatSession(binding.activeSession) : "未绑定"} />
      <KeyValue label="当前权限" value={binding.permission ? formatPermission(binding.permission) : "使用默认权限"} />
      {binding.activeSession ? <KeyValue label="最近活跃" value={formatSessionActiveTime(binding.activeSession.updatedAt, "full")} /> : null}
      {binding.activeSession?.cwd ? <KeyValue label="工作目录" value={binding.activeSession.cwd} /> : null}
      {binding.route.lastSeenAt ? <KeyValue label="最近消息" value={binding.route.lastSeenAt} /> : null}
      <Section title="操作">
        {items.map((item, index) => <ListRow key={item} active={selected === index} left={`${index + 1}. ${item}`} tone={item.startsWith("解绑") ? "warning" : undefined} />)}
      </Section>
    </Frame>
  );
}

export function PairingView({ pairing, selected }: { pairing: PairingDashboardSummary; selected: number }): React.JSX.Element {
  // fixed: Frame(4) + summary section(4) + description section(4) + footer(2) = 14
  const viewportRows = useViewportRows(14);
  const routes = pairing.routes;
  const pw = visibleWindow(routes, selected, viewportRows);
  return (
    <Frame title="配对管理" subtitle="Enter 详情  m 手动信任  r 撤销信任  u 撤销并解绑">
      <Section title="概览">
        <Text>已信任 {pairing.trusted} 个聊天，待配对 {pairing.pending} 个聊天。</Text>
      </Section>
      <Section title="聊天">
        {routes.length === 0 ? <Muted text="还没有发现任何聊天。启动服务后，微信或飞书私聊发来消息才会出现在这里。" /> : (
          <>
            <ScrollHint above={pw.above} below={0} />
            {pw.slice.map((route, i) => {
              const index = pw.startIndex + i;
              return (
                <ListRow
                  key={route.route.routeKey}
                  active={selected === index}
                  left={`${index + 1}. ${route.trusted ? "已信任" : "待配对"}   ${route.label}`}
                  right={pairingRouteRight(route)}
                  tone={route.trusted ? "success" : "warning"}
                />
              );
            })}
            <ScrollHint above={0} below={pw.below} />
          </>
        )}
      </Section>
      <Section title="说明">
        <Muted text="配对码只会在运行日志里显示，不会发送到微信或飞书；启动前 TUI 只管理已发现 route 的信任记录。" />
      </Section>
    </Frame>
  );
}

export function PairingDetailView({ pairing, selected }: { pairing?: PairingRouteSummary; selected: number }): React.JSX.Element {
  if (!pairing) return <Frame title="配对详情"><Muted text="这个聊天 route 已不存在。" /></Frame>;
  const trusted = pairing.trustedRecord;
  const items = pairing.trusted
    ? [
        "撤销信任，保留 session 绑定",
        pairing.activeSession ? "撤销信任，并解绑 session" : "撤销信任，并解绑 session（当前未绑定）",
        "返回配对管理",
      ]
    : [
        "本机确认并信任",
        "返回配对管理",
      ];
  return (
    <Frame title="配对详情" subtitle={pairing.trusted ? "r 撤销信任  u 撤销并解绑  Esc 返回" : "m 手动信任  Esc 返回"} borderColor={pairing.trusted ? THEME.success : THEME.warning}>
      <KeyValue label="聊天" value={pairing.label} />
      <KeyValue label="状态" value={pairing.trusted ? "已信任" : "待配对"} />
      <KeyValue label="Route" value={pairing.route.routeKey} />
      <KeyValue label="渠道" value={`${pairing.route.channelId} / ${pairing.route.accountId}`} />
      <KeyValue label="最近活跃" value={formatFullDateTime(pairing.route.lastSeenAt ?? pairing.route.updatedAt)} />
      <KeyValue label="当前绑定" value={pairing.activeSession ? formatSession(pairing.activeSession) : "未绑定"} />
      {trusted ? (
        <Section title="信任记录">
          <KeyValue label="信任时间" value={formatFullDateTime(trusted.trustedAt)} />
          <KeyValue label="信任方式" value={trusted.trustMethod === "manual" ? "本机手动信任" : "配对码"} />
          <KeyValue label="信任人" value={[trusted.trustedBySenderId, trusted.trustedBySenderDisplayName].filter(Boolean).join(" / ")} />
        </Section>
      ) : (
        <Section title="说明">
          <Muted text="待配对聊天不能创建、绑定或切换 Codex session；可以等待对方发送 /pair 配对码，或在本机手动确认信任。" />
        </Section>
      )}
      <Section title="操作">
        {items.map((item, index) => (
          <ListRow
            key={item}
            active={selected === index}
            left={`${index + 1}. ${item}`}
            tone={item.startsWith("撤销") ? "danger" : item.startsWith("本机") ? "warning" : undefined}
          />
        ))}
      </Section>
    </Frame>
  );
}

export function SessionSelectView({ choices, selected, binding }: { target: SessionTarget; choices: SessionChoices; selected: number; binding?: BindingSummary }): React.JSX.Element {
  // fixed: Frame(4) + KeyValue binding(1) + section header(3) + footer(2) = 10
  const viewportRows = useViewportRows(10);
  const ssw = visibleWindow(choices.selectable, selected, viewportRows);
  return (
    <Frame title="选择 Codex session" subtitle="Enter 绑定  数字选择  n 新建  m 手动输入">
      {binding ? <KeyValue label="聊天" value={binding.label} /> : null}
      <Section title="可选">
        {choices.selectable.length ? (
          <>
            <ScrollHint above={ssw.above} below={0} />
            {ssw.slice.map((item, i) => <SessionRow key={item.id} index={ssw.startIndex + i} active={selected === ssw.startIndex + i} session={item} />)}
            <ScrollHint above={0} below={ssw.below} />
          </>
        ) : <Muted text="暂无可选历史 session。" />}
      </Section>
      {choices.unavailable.length ? (
        <Section title="不可选">
          {choices.unavailable.map((item) => <Text key={item.id}>已绑定到 {item.ownerLabel}    {formatSessionWithActivity(item)}</Text>)}
        </Section>
      ) : null}
    </Frame>
  );
}

export function ManualSessionView({ value, onChange, onSubmit }: { value: string; onChange(value: string): void; onSubmit(value: string): void | Promise<void> }): React.JSX.Element {
  return (
    <Frame title="手动输入 Session ID" subtitle="Enter 绑定  Esc 返回">
      <Text>请输入本机已有 Codex Session ID。</Text>
      <Box marginTop={1}>
        <Text>Session ID: </Text>
        <TextInput defaultValue={value} onChange={onChange} onSubmit={onSubmit} />
      </Box>
    </Frame>
  );
}

export function PermissionView({ target, startupPolicy, sessionPolicy, selected }: { target: PermissionTarget; startupPolicy: CodexRunPolicy; sessionPolicy?: CodexRunPolicy; selected: number }): React.JSX.Element {
  const current = target.kind === "default" ? startupPolicy : sessionPolicy ?? startupPolicy;
  return (
    <Frame title={target.kind === "default" ? "默认权限设置" : "当前 session 权限"} subtitle="Enter 保存  Esc 返回">
      {target.kind === "session" ? <KeyValue label="Session" value={formatSession(target.session)} /> : null}
      <KeyValue label="当前" value={formatPermission(current)} />
      <Section title="选项">
        <ListRow active={selected === 0} left="1. 审批模式（推荐）" tone="success" />
        <ListRow active={selected === 1} left="2. 完全权限（高风险）" tone="danger" />
      </Section>
    </Frame>
  );
}

export function WorkdirView({ cwd, processCwd, selected }: { cwd: string; processCwd: string; selected: number }): React.JSX.Element {
  return (
    <Frame title="工作目录" subtitle="Enter 执行  m 输入路径  Esc 返回">
      <KeyValue label="当前新 session" value={cwd} />
      <KeyValue label="当前终端目录" value={processCwd} />
      <Section title="说明">
        <Muted text="只影响以后新建的 session；已有 session 继续使用自己的工作目录。" />
      </Section>
      <Section title="操作">
        <ListRow active={selected === 0} left="1. 使用当前终端目录" right={processCwd} />
        <ListRow active={selected === 1} left="2. 输入目录路径" right="支持绝对路径、相对路径和 ~" />
      </Section>
    </Frame>
  );
}

export function WorkdirInputView({ value, onChange, onSubmit }: { value: string; onChange(value: string): void; onSubmit(value: string): void | Promise<void> }): React.JSX.Element {
  return (
    <Frame title="输入工作目录" subtitle="Enter 保存  Esc 返回">
      <Text>请输入以后新建 Codex session 使用的工作目录。</Text>
      <Box marginTop={1}>
        <Text>目录: </Text>
        <TextInput defaultValue={value} placeholder="./project" onChange={onChange} onSubmit={onSubmit} />
      </Box>
    </Frame>
  );
}

export function StatusView({ dashboard }: { dashboard: LauncherDashboard }): React.JSX.Element {
  return (
    <Frame title="状态详情" subtitle="Enter/Esc 返回">
      <Section title="Codex CLI">
        <CodexCliStatusBlock status={dashboard.startup.codexStatus} />
      </Section>
      <Section title="渠道">
        {dashboard.channels.length ? dashboard.channels.map((channel) => (
          <Box key={channel.record.id} flexDirection="column" marginBottom={1}>
            <KeyValue label="备注" value={channel.record.displayName ?? "未设置"} />
            <KeyValue label="添加时间" value={formatFullDateTime(channel.record.createdAt)} />
            <KeyValue label="更新时间" value={formatFullDateTime(channel.record.updatedAt)} />
            <Text>{formatChannelStatusDetails(channel.status, channel.capabilities)}</Text>
          </Box>
        )) : <Muted text="暂无渠道。" />}
      </Section>
      <Section title="绑定">
        <Text>已发现聊天：{dashboard.routes.known}  已绑定：{dashboard.routes.bound}  待生效：{dashboard.routes.pending ?? 0}</Text>
      </Section>
      <Section title="配对信任">
        <Text>已信任：{dashboard.pairing.trusted}  待配对：{dashboard.pairing.pending}</Text>
      </Section>
      <Section title="运行">
        <Text>服务未启动。</Text>
      </Section>
    </Frame>
  );
}

function CodexCliStatusBlock({ status }: { status?: CodexCliStatus }): React.JSX.Element {
  const available = status?.available ?? false;
  return (
    <>
      <KeyValue label="平台" value={formatCodexPlatform(status)} />
      <KeyValue label="状态" value={status ? (available ? "✓ 已找到" : "✗ 不可用") : "尚未检测"} />
      {status?.version ? <KeyValue label="版本" value={status.version} /> : null}
      {status && !available && status.error ? <KeyValue label="错误" value={status.error} /> : null}
      {status ? <KeyValue label="路径" value={status.codexBin} /> : null}
      {status ? <KeyValue label="来源" value={formatCodexCommandSource(status.codexBinSource)} /> : null}
    </>
  );
}

export function StartConfirmView({ validation, lines }: { validation: StartValidation; lines: string[] }): React.JSX.Element {
  const groups = parseStartSummary(lines);
  return (
    <Frame title="启动服务" subtitle={validation.ok ? "Enter 启动并进入运行日志  Esc 返回" : "Esc 返回"} borderColor={validation.ok ? THEME.success : THEME.warning}>
      <Section title={validation.ok ? "确认启动" : "需要处理"}>
        <Text color={validation.ok ? THEME.success : THEME.warning} bold>{validation.ok ? "▶ 确认后会启动 Bridge，并进入 Chat Codex 运行中面板。" : `⚠ ${lines[0]}`}</Text>
        {validation.ok ? <KeyValue label="运行中面板" value="展示已启动渠道、工作目录、默认权限、聊天日志和 Ctrl+C 停止方式" /> : null}
      </Section>
      {validation.ok ? groups.map((group) => (
        <Section key={group.title} title={group.title}>
          {group.items.map((item) => {
            const [label, value] = splitSummaryItem(item);
            return value ? <KeyValue key={item} label={label} value={value} /> : <Text key={item}>- {item}</Text>;
          })}
        </Section>
      )) : null}
    </Frame>
  );
}

export function HelpView(): React.JSX.Element {
  return (
    <Frame title="快捷键" subtitle="Enter/Esc 返回">
      {[
        "全局: ↑↓ 选择，Enter 执行，Esc/q 返回，r 刷新，? 帮助。",
        "首页: c 渠道，b 绑定，t 配对，p 权限，d 工作目录，s 状态，w 添加微信，f 添加飞书。",
        "渠道: w 添加微信，f 添加飞书，e 启停。",
        "绑定: n 新建并绑定，m 手动绑定，u 解绑，p 权限。",
        "配对: m 手动信任，r 撤销信任，u 撤销信任并解绑。",
      ].map((line) => <Text key={line}>{line}</Text>)}
    </Frame>
  );
}

export function LoadingView({ title, message }: { title: string; message: string }): React.JSX.Element {
  return <Frame title={title}><Muted text={message} /></Frame>;
}

function feishuStepLabel(step: Extract<Screen, { name: "addFeishu" }>["step"]): string {
  if (step === "appId") return "FEISHU_APP_ID";
  if (step === "appSecret") return "FEISHU_APP_SECRET";
  return "账号标识";
}

function defaultForFeishuStep(step: Extract<Screen, { name: "addFeishu" }>["step"]): string {
  return "";
}

function parseStartSummary(lines: string[]): Array<{ title: string; items: string[] }> {
  const groups: Array<{ title: string; items: string[] }> = [];
  let current: { title: string; items: string[] } | undefined;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line === "即将启动") continue;
    if (!line.startsWith("- ")) {
      current = { title: line, items: [] };
      groups.push(current);
      continue;
    }
    if (!current) {
      current = { title: "摘要", items: [] };
      groups.push(current);
    }
    current.items.push(line.slice(2));
  }
  return groups;
}

function splitSummaryItem(item: string): [string, string | undefined] {
  const index = item.indexOf(": ");
  if (index < 0) return [item, undefined];
  return [item.slice(0, index), item.slice(index + 2)];
}

function pairingRouteRight(route: PairingRouteSummary): string {
  if (route.trustedRecord) return `配对 ${formatShortDateTime(route.trustedRecord.trustedAt)}`;
  return `最近 ${formatShortDateTime(route.route.lastSeenAt ?? route.route.updatedAt)}`;
}
