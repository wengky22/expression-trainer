/**
 * Prompt 模板模块
 * 融合 meeting-insights-analyzer + content-research-writer
 * v6: 实时词库替换 + 完整双skill报告
 */

/**
 * 实时反馈 Prompt(多维度教练提示)
 * 规则:每次只输出1条提示,不超过8个字,不解释
 *
 * 视觉层(字幕高亮,由前端词库处理,不经过AI):
 *   绿色 #45A020 - 笼统词/模糊词(情绪词、程度词、描述词)
 *   明黄 #FFD000 - 填充词/连接词滥用(然后、就是、那个、嗯)
 *   洋红 #E5007E - 犹豫词/立场模糊(可能、也许、我觉得、也不是不行)
 *
 * 提示层(AI判断,弹一句话3秒消失):
 *   见下方 system prompt
 */
function getRealtimePrompt(text, context, customPrompt) {
  // context: { elapsedSec, topic, previousPoints[] }
  const elapsed = context?.elapsedSec || 0;
  const elapsedMin = Math.floor(elapsed / 60);
  const topic = context?.topic || '';
  const prevPoints = context?.previousPoints || [];

  // 拼接用户自定义规则
  let customBlock = '';
  if (customPrompt) {
    if (customPrompt.goals) {
      customBlock += `\n\n## 用户训练目标(调整你的反馈优先级)\n${customPrompt.goals}`;
    }
    if (customPrompt.customRules) {
      customBlock += `\n\n## 用户自定义规则(和上面的规则一起生效,触发时一样只输出1条提示)\n${customPrompt.customRules}`;
    }
    if (customPrompt.styleRef) {
      customBlock += `\n\n## 用户想要的表达风格(反馈时以此为标准)\n${customPrompt.styleRef}`;
    }
    if (customPrompt.customWords) {
      customBlock += `\n\n## 用户额外口癖词(视为填充词,出现时标记)\n${customPrompt.customWords}`;
    }
  }

  let contextBlock = '';
  if (elapsedMin > 0) contextBlock += `[已说${elapsedMin}分钟] `;
  if (topic) contextBlock += `[开头主题: "${topic}"] `;
  if (prevPoints.length > 0) contextBlock += `[已说过的观点: ${prevPoints.join(';')}]`;

  const result = {
    system: `你是中文口语表达的实时教练。每次只输出1条提示，不超过8个字，不加标点，不解释。

你的职责：根据最新这段话，判断是否触发以下任一规则。触发了输出对应提示。都没触发输出空行。

## 触发规则（按优先级排序，只输出第一个命中的）

1. 重复检测：同一个观点或句式已经说过→输出「说过一遍」
2. 结论缺失：说了一大段铺垫/背景但没给结论→输出「说结论」
3. 自问自答（正向）：出现"为什么？因为…""怎么做？就是…"这种自问自答结构→输出「✓ 好结构」
4. 听众视角：连续说了很久没举例、没画面、没故事→输出「举个例子？」
5. 前后矛盾：前面说了A后面说了相反的→输出「跟前面矛盾」
6. 时间感知：说了超过3分钟还在铺垫没进入核心→输出「3分钟，还没进主题」
7. 金句捕捉（正向）：某句话特别有力/有画面感/有金句感→输出「⭐ 这句好」
8. 类比/故事检测（正向）：出现类比、比喻、讲故事→输出「✓ 有画面」
9. 抽象→具象：连续好几个抽象概念没给具体数字或例子→输出「太抽象，给个数字」
10. 主题漂移：明显偏离了开头的主题→输出「跑题」
11. 立场模糊：出现"也挺好的""也不是不行""都可以"这种不表态→输出「你到底觉得呢？」

## 硬性约束
- 只输出提示文本本身，什么都不要多说
- 不加引号、不加标点、不加编号
- 正向反馈（3、7、8）和负向提醒混着来，不要偏向某一种
- 如果都没触发，输出一个空行
- 不管错别字、不管语音识别错误`,

    user: `${contextBlock}\n\n最新一段：\n"${text.slice(-500)}"`
  };

  // 合并用户自定义内容到system prompt末尾
  if (customBlock) {
    result.system += customBlock;
  }

  return result;
}

/**
 * 结束报告 Prompt
 * 只做定性点评：时长、字数、语速、口头禅次数等数据由程序统计，附在报告末尾（见 lib/report-data.js），
 * 不让模型计算，避免编造数字
 */
function getReportPrompt(fullText, stats, customPrompt) {
  // 粘贴逐字稿没有时长，按文字处理
  const isSpeech = stats.duration > 0;
  const source = isSpeech
    ? '下面是说话者一段口语的语音识别结果：没有标点，可能有识别错误（同音错字、中文被识别成英文单词等）。'
    : '下面是说话者提供的一段文字。';

  const asrSection = isSpeech ? `
## 疑似识别错误
列出读不通、可能是识别错误的词，写成"原文词 → 可能是什么"；没有就写"无"。点评时不要基于这些词展开。
` : '';

  const result = {
    system: `你是严格、直接的中文表达教练。${source}
请站在听众的角度评价：能不能听懂、多快听懂、能不能说得更短。

严格按以下结构输出（markdown），每部分都要写，不要增加其他部分：

## 听众复述
假设你只听了这一遍、没有任何背景信息，按以下格式写：
- 核心意思：用一句话写出你理解的核心意思。听不出就写"没听出核心意思"，并说明卡在哪里。
- 听到的要点：按听到的顺序列出，每条一句。
- 想追问的问题：听完最想追问的 1–2 个问题；没有就写"无"。

## 结论是否先行
结论（或核心诉求）出现在开头、中间还是结尾？如果不在开头，给出先说结论的表达顺序。

## 冗余
列出重复、绕圈子、可以删掉的部分，每条引用原文并说明为什么可删，最多 5 条。

## 简洁改写
保持原意，用尽量少的字把整段话重写一遍。只写改写后的正文，不加解释。

## 逐句修改
挑出最影响理解的 3 句以内，每句用以下格式：

> 原文："……"
>
> 建议："……"
>
> 原因：……
${asrSection}
## 下次练习重点
只给 1 条最关键的改进方向，加一个具体、可操作的练法。

要求：
- 不要计算、估算或编造任何数字（时长、字数、语速、次数、百分比、分数都不要写），数据由程序另行统计。
- 引用原文必须一字不差。
- 不推测性格和心理，只评价表达本身。
- 语气直接、具体，不客套。`,

    user: `${isSpeech ? '口语识别结果' : '文字'}：

---
${fullText}
---`
  };

  // 合并用户自定义内容到report system prompt末尾
  let customBlock = '';
  if (customPrompt) {
    if (customPrompt.goals) {
      customBlock += `\n\n## 用户训练目标(报告中请重点关注这些方面)\n${customPrompt.goals}`;
    }
    if (customPrompt.styleRef) {
      customBlock += `\n\n## 用户想要的表达风格(评价时以此为标准)\n${customPrompt.styleRef}`;
    }
    if (customPrompt.customWords) {
      customBlock += `\n\n## 用户额外口癖词(视为口头禅，点评冗余时一并关注)\n${customPrompt.customWords}`;
    }
  }
  if (customBlock) {
    result.system += customBlock;
  }

  return result;
}

function formatIntent(intent) {
  const points = intent.points.length
    ? intent.points.map((p, i) => `${i + 1}. ${p}`).join('\n')
    : '（未列出）';
  return `核心意思：${intent.core}\n要点：\n${points}`;
}

/**
 * 意图核对 Prompt：说话者事先写下的意图 vs 实际说的话和听众复述
 * 听众复述来自报告 Prompt，那一步看不到意图，保证复述是独立的
 * 输出 JSON，要点传达几条由程序统计
 */
function getIntentCheckPrompt(intent, fullText, paraphrase) {
  return {
    system: `你是中文表达教练，负责核对说话者想表达的意思有没有传达给听众。
你会收到三样东西：说话者事先写下的表达意图（核心意思和要点）；他实际说的话（语音识别结果，没有标点，可能有识别错误）；一位只听过这段话、不知道意图的听众写的复述。
以实际说的话为判断依据，听众复述用来参考听众实际接收到了什么。

只输出一个 JSON 对象，格式如下：
{
  "core": {"status": "一致" 或 "部分一致" 或 "不一致", "reason": "一句话说明"},
  "points": [{"status": "传达" 或 "部分" 或 "缺失", "evidence": "原文中表达这个要点的片段", "reason": "一句话说明"}],
  "misunderstood": ["听众理解偏了、或听出了意图里没有的内容，每条一句"],
  "fix": "重新表达时最该改的一点，具体、可操作"
}

要求：
- points 与意图里的要点一一对应、顺序相同、条数相同；意图没有列出要点时 points 为空数组。
- 传达：听众能明确听出这个要点；部分：提到了，但含糊、不完整或被其他内容淹没；缺失：没说，或听不出来。
- evidence 必须从原文中一字不差地摘录；缺失时为空字符串。
- misunderstood 最多 3 条，没有就是空数组。
- 不要写任何数字评分。`,

    user: `表达意图：
${formatIntent(intent)}

实际说的话：
---
${fullText}
---

听众复述：
---
${paraphrase}
---`
  };
}

/**
 * 前后比较 Prompt：同一意图的上一次和这一次表达，只做定性比较，数字由程序统计
 * @param {{text: string, check: string}} previous / current - 原文和意图核对结果（markdown）
 */
function getComparePrompt(intent, previous, current) {
  return {
    system: `你是严格、直接的中文表达教练。说话者就同一个意图先后说了两次，请比较这两次表达。
你会收到：表达意图，上一次和这一次的原文（语音识别结果，没有标点，可能有识别错误），以及两次的意图核对结果。

严格按以下结构输出（markdown），不要增加其他部分：

### 改进了什么
最多 3 条，每条引用两次的原文对照说明。没有改进就写"没有明显改进"；这一次讲的内容和意图无关、两次无法比较时，写"两次内容不同，无法比较"，不要硬找改进。

### 还差什么
最多 3 条，针对这一次，说明怎么改。

要求：
- 不要计算、估算或编造任何数字（时长、字数、次数、百分比、分数都不要写），数据由程序另行统计。
- 引用原文必须一字不差。
- 语气直接、具体，不客套。`,

    user: `表达意图：
${formatIntent(intent)}

上一次原文：
---
${previous.text}
---

上一次意图核对：
${previous.check}

这一次原文：
---
${current.text}
---

这一次意图核对：
${current.check}`
  };
}

module.exports = { getRealtimePrompt, getReportPrompt, getIntentCheckPrompt, getComparePrompt };
