---
name: teach
description: 教泡泡业务知识。"泡泡记住/注意/更新/忘记"指令自动创建 pinned entity bubble。
triggers:
  patterns:
    - "泡泡\\s*(记住|记下|学习|知道|注意|留意|更新|修改|纠正|忘记|忘掉|删除|取消|别记)"
  keywords:
    - 泡泡记住
    - 泡泡注意
    - 泡泡更新
    - 泡泡忘记
    - 泡泡修改
    - 泡泡学习
handler: teach
priority: 15
---

# 教泡泡

用户通过自然语言"教"泡泡业务规则和知识，泡泡自动创建 pinned entity bubble 长期存储。

## 触发句式

- "泡泡记住：桂鑫没有盘螺产品"
- "泡泡注意：汉浦路项目回款一直拖延"
- "泡泡更新：马台联系人换成张总 13900001234"
- "泡泡忘记：桂鑫没有盘螺产品"

## 处理流程

1. **检测** (detector.ts): 正则匹配"泡泡+动词+冒号+内容"，零 LLM 成本
2. **解析** (parser.ts): 一次 LLM 调用，提取实体名、属性、值等结构化字段
3. **存储** (store.ts): 创建 pinned entity bubble，冲突时过期旧卡

## 动作类型

| 动词 | 动作 | 行为 |
|------|------|------|
| 记住/记下/学习/知道 | remember | 新建知识卡 |
| 注意/留意/小心 | note | 新建注意事项卡 |
| 更新/修改/改一下/纠正 | update | 新建 + 过期旧卡 |
| 忘记/忘掉/删除/取消/别记 | forget | 标记旧卡过期（加速衰减） |

## 存储特征

- type: entity, pinned: true, abstractionLevel: 1
- decayRate: 0.01（长期保持）
- 冲突策略：新建 + 旧卡 pinned→false 自然衰减
- 遗忘策略：旧卡 pinned→false + decayRate→0.5 加速衰减
