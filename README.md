# dsh-handoff-state

把当前场景的 `§〇 当前交接` 每一轮重新放回模型眼前。

> English: DSH host plugin that re-injects the active scene's handoff section
> into the runtime-context block on every step, so a new session starts from the
> recorded state instead of from zero. 4000-byte budget, water-filled across
> fields, with a pointer back to the full file.

---

## 它解决什么

交接文件、校验它的闸门（`handoff.mjs`）、报告它的体检（`health.mjs`）三者都写了、都能跑。
问题不在存储，在**没有东西在读它**。

`AGENTS.md` 里写着「任务开始前先读当前场景的交接」——但写在散文里的规则，在负载高的时候
就会被跳过。实测：这条规则加进宪法之前，`grep 场景记忆` 在工作会话里是零命中；加进之后，
依然没有任何强制。

宿主插件不能改写模型的指令，但可以往 **runtime-context 块**里加一条。这个块每一步都整段
重渲染，是唯一「新鲜度有保证」的位置。

### 为什么是 runtime-context，不是 prompt section

prompt section 属于被缓存的 system 前缀，改一个字就让整个前缀失效，下一次请求要重新付
整段缓存（本机实测一次 section 变更触发约 161K token 的重新计费）。

runtime-context 块本来就在 step 之间变化（工作目录、todo 状态），所以只要**内容不变**，
放进这里是零成本——loop 只在拼接后的文本真的不同时才接纳新快照。

这条「只在文本变化时接纳」的规则反过来约束了渲染：**渲染结果不能依赖比粗粒度时间桶更细的
时钟**，否则插件会每一步都注入一条新的用户消息。

---

## 工作原理

| 位置 | 行为 |
|---|---|
| `ctx.systemPrompt.context({ name: 'handoff:state', order: 135 })` | 注册一个文本提供者，每步调用 |
| `resolveScene(cwd, index)` | 用会话工作目录匹配场景名，匹配不到返回 `null`（不注入） |
| `statSync` 缓存键 `${size}:${mtimeMs}:${memKey}` | 文件没变就直接返回上次的字符串，保证逐字节相同 |
| `renderHandoffState(...)` | 按 4000 B 预算渲染 §〇，超了截断并附全文指针 |

`order: 135` 的位置：工作目录(100)、沙箱(110)、审批(115)、子代理(120)、团队(125)、
todo 重述(130) 之后。交接摘要和 todo 一样回答「我刚才做到哪」，所以紧挨着它。

### 4000 字节预算怎么花

1. 先算记忆索引行（最多占 20%），从预算里扣掉；
2. 剩下的按**注水**分配：能整段放下的字段全额放行并退出竞争，放不下的再均分；
3. 仍超预算就对最长的非指针行再切 64 字节，直到合规；
4. 被截断时尾部追加一行：`（§〇 已按 N 字节预算压缩，全文：<文档路径>）`。

均分（旧做法）会把最长的「做到哪」砍掉 64%，同时留 356 B 没用上——现在按需分配，
浪费控制在 120 B 以内。

### 场景解析的坑

`resolveScene` 在**只有一个场景**时会无条件返回它，与工作目录无关。本机曾因此把「客服知识库」
的 Telegram 值班交接注入到 DSH 工作目录的每一轮。修法是建第二个场景（本机是「DSH 运维」），
让路径匹配真正生效。场景名最好出现在工作目录路径里。

场景在会话内只解析一次（工作目录不会中途移动）。会话开着时新建场景不会立即生效。

---

## 装

```bash
cd ~/.dsh/profiles/desktop
pnpm add link:/absolute/path/to/dsh-workspace/link-plugins/dsh-handoff-state

   # Windows 上 `~` 不会展开，直接给绝对路径，例如：
   #   pnpm add link:C:/Users/you/Documents/dsh-workspace/link-plugins/dsh-handoff-state
```

然后在 profile 的 `dsh.profile.bundles` 里加 `dsh-handoff-state`。bundle 自带的
`cordis.patch.yml` 会自动加载——**不要**把它的 insert 块抄进 profile 的
`cordis.patch.yml`，那会造成重复条目 ID，设置面板会存不了盘。

要覆盖配置时，在 profile 的 patch 里加**顶层**行：

```yaml
- id: handoff-state
  config:
    enabled: true
    scenesRoot: 'D:/my-scenes'
```

---

## 配置

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时一行都不注册 |
| `scenesRoot` | `~/.dsh/场景记忆` | 场景根目录 |

## 数据格式

`<scenesRoot>/<场景>/场景私有记忆.md`：

```markdown
# 客服知识库 · 场景私有记忆

## §〇 当前交接
- 更新: 2026-11-03 16:12
- 目标: ...
- 做到哪: ...
- 下一步: ...
- 未决: ...

## §一 环境与访问事实
...
```

四个字段缺一个、时间戳写成未来、出现 `<待填>` 之类占位符，都会被 `handoff.mjs` 判失败。
`更新` 超过 90 分钟是 `stale`（警告），超过 24 小时是 `cold`（默认阻断，`--allow-cold` 放行）。

`<scenesRoot>/_共享记忆/索引.json` 登记所有场景：

```json
{ "场景": ["客服知识库", "DSH 运维"], "说明": "每个场景一个目录…" }
```

索引缺失时退化扫描目录；索引与目录不一致时 `handoff.mjs --all` 会报出来。

### 自动记忆

`<scenesRoot>/<场景>/自动记忆/_index.json` 若存在，其中的 topic 会压成一行：

```
自动记忆: rea-工具开销、patch-写回机制（正文用 node ~/.dsh/tools/memory.mjs --get <topic> 读）
```

正文不注入，只给索引——这是刻意的：记忆正文无限长，索引有上限（默认 20 条），
超了 `memory.mjs --add` 会拒绝而不是静默截断。

---

## 排错

| 症状 | 原因 |
|---|---|
| 每轮都没有交接行 | 工作目录不匹配任何场景（`resolveScene` 返回 `null`）→ 建一个名字出现在路径里的场景 |
| 有交接但内容很旧 | 场景文件没更新，`handoff.mjs` 会报 `cold` |
| 模型说「我刚才做到哪想不起来了」 | 场景在会话开始时解析为 `null`，之后没有重新解析 |
| 交接被截断 | §〇 超过 4000 B，`handoff.mjs --all` 会报 `budget` |
| 每步都多一条用户消息 | 渲染里混进了会变的数值（时间戳、计数器） |

插件内部任何异常都退化成空字符串，不会让这一轮挂掉——代价是静默：真出问题时现场没有任何
报错，只能靠 `handoff.mjs` 从外部体检。

---

## 测试

```bash
node test-state.mjs   # 解析、桶判定、预算分配、截断落点，18 个用例
node test-host.mjs    # 宿主侧注册、缓存键、异常降级，10 个用例
```

`node --test` 在 DSH 沙箱里跑不起来（它要 spawn 子进程），直接 `node` 跑文件。

## License

MIT
