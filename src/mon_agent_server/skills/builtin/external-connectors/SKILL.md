---
name: external-connectors
description: 自主使用当前用户共享的 Lichess、OpenTTD 等外部服务，领取事件并执行动作。
metadata:
  monagent:
    display_name: 外部连接器
    version: 1.0.0
    tools: [web, list_connectors, register_connector, set_connector_state, claim_connector_events, finish_connector_events, execute_connector_action, query_openttd, openttd_newgrf]
    profiles: [user_chat, self_awake]
---

- 连接器只负责收发事实，你负责决定是否连接、何时领取、如何处理以及执行什么动作。
- 连接器配置属于当前用户并由其所有助手共享。需要一个新身份时调用 register_connector；identity_key 是稳定身份名称，不填写或索取 Token。已注册身份使用 set_connector_state 自主连接或断开。
- 想查看外部世界是否有新信息时调用 claim_connector_events；每次领取都会返回 lease_id。处理成功后必须确认完成，暂时无法处理或执行失败时释放等待重试。
- Lichess 事件的 payload 包含挑战、棋局或局面事实；通过 execute_connector_action 接受或拒绝挑战、走棋、认输、提和或聊天。动作参数严格使用工具契约中的 snake_case 字段；拒绝原因使用工具列出的 Lichess 原因代码。不要用文字声称已经执行而跳过工具。
- 收到 OpenTTD 聊天事件并想回应时，使用 execute_connector_action 的 send_chat，payload 只需 text；它会向当前 OpenTTD 服务器聊天发送消息。
- 协助用户玩 OpenTTD 时先用 query_openttd 观察公司、地图格、附近城镇、产业、可购道路车辆、车站和车辆。整条线路优先使用 execute_connector_action 的 gameplay_plan，把 build_road、build_road_station、build_road_depot、buy_road_vehicle 等步骤作为 commands 一次提交；单步调整才用 gameplay_command。company_id 只是操作目标。计划返回 ok=true 后再次查询资产确认；失败时根据 failed_at 和 results 明确报告已完成及未完成步骤。
- 需要查看或添加 OpenTTD 模组（NewGRF）时，用 openttd_newgrf：action=list 列出本地已安装模组；action=place 将用户提供的 .grf 文件复制进 OpenTTD 内容目录供新建游戏使用。注意：NewGRF（含城镇名）只能在新建游戏时生效，运行中的存档无法中途启用；openttd.cfg 的 [newgrf] 段记录的是引擎内部 ID（由 grfid+内容哈希计算），无法在外部手工伪造，因此不提供直接写配置的假能力，只做列出与放置。
- 陪用户玩 OpenTTD 时可以主动查阅游戏资料。对产业链、车辆机制、信号、站点覆盖、经济规则或版本行为不确定时，使用 web 搜索并打开 OpenTTD Wiki（wiki.openttd.org）或官方源码/API 文档（docs.openttd.org）；优先采用与 OpenTTD 15.3 相符的资料，不凭印象编造规则。
- 网页资料解释通用规则，query_openttd 提供当前存档事实；规划和操作前把两者结合。已有可靠知识且局面查询足够时直接协助，不为每个普通动作机械搜索。
- 技能说明只能通过 load_skill 加载；SKILL.md 的 location 是可读取的真实本地路径。
- 共享事件由领取它的当前助手负责；事件记录会保存实际处理助手，不把其他角色已经完成的决定或棋局视为自己的。
