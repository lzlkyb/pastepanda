/**
 * 新建自定义动作时的模板示例。
 *
 * 空白文本框是最大的启动障碍——大多数人不是不想要，是不知道该怎么写。
 *
 * 挑选原则：**每一条都不与内置动作重叠**。重叠的示例只会让用户造出一堆
 * 和内置功能一模一样的动作，把变换中心冲成重复列表。
 *
 * 每条自带 `sample`，让“试跑”一点就能看到效果，不用用户自己找测试数据。
 */

export interface ActionTemplate {
  name: string;
  description: string;
  icon: string;
  template: string;
  maxTokens: number;
  contentTypes: string[];
  /** 试跑用的示例输入 */
  sample: string;
}

export const ACTION_TEMPLATES: ActionTemplate[] = [
  {
    name: "提取待办",
    description: "从会议记录里抽出待办项",
    icon: "check-square",
    contentTypes: [],
    maxTokens: 800,
    template:
      "从下面的记录里抽出待办项，每行一条，格式：- [ ] 事项（负责人，截止时间）。\n" +
      "没写负责人或时间的就留空，不要猜。\n\n{{内容}}\n\n只输出列表。",
    sample:
      "今天讨论了下周上线。小王周三前把登录页改完，后端这边还得做数据库迁移，" +
      "测试周五前跑完回归。另外文档还没人领。",
  },
  {
    name: "起变量名",
    description: "根据描述给几个命名候选",
    icon: "tag",
    contentTypes: ["text", "code"],
    maxTokens: 300,
    template:
      "下面是对一个变量/函数的描述。给 5 个英文命名候选，每行一个，后面用——接一句中文理由。\n" +
      "先给最推荐的那个。\n\n{{内容}}",
    sample: "判断用户是不是第一次打开这个面板的布尔值",
  },
  {
    name: "翻译成日文",
    description: "固定目标语言，不用每次选",
    icon: "languages",
    contentTypes: [],
    maxTokens: 2000,
    template: "把下面的内容翻译成日文，保持原有换行与标点：\n\n{{内容}}",
    sample: "麻烦确认一下交付时间，谢谢。",
  },
  {
    name: "精简一半",
    description: "压到一半长，信息点不丢",
    icon: "minimize-2",
    contentTypes: ["text", "markdown"],
    maxTokens: 1500,
    template:
      "把下面的内容压到大约一半长。要求：信息点一个不能丢，只删冗余表达；\n" +
      "不要改成提纲式，仍然是成段的话。\n\n{{内容}}",
    sample:
      "关于这个问题呢，我个人觉得其实吧，我们可能需要再认真地、仔细地考虑一下，" +
      "因为它涉及到的方面确实是比较多的，不能就这么草率地做出决定。",
  },
  {
    name: "写成正式邮件",
    description: "把随手写的要点扩成邮件",
    icon: "mail",
    contentTypes: ["text"],
    maxTokens: 1500,
    template:
      "下面是我随手写的要点。把它扩成一封正式邮件：带主题行、称呼、正文、结尾；\n" +
      "不要编我没说过的事实与承诺。\n\n{{内容}}",
    sample: "跟对方说下周的评审推迟到下下周二，原因是数据还没齐，到时候我们提前两天发材料",
  },
  {
    name: "解释报错",
    description: "这条报错什么意思、常见原因",
    icon: "circle-alert",
    contentTypes: ["log", "shell", "code"],
    maxTokens: 800,
    template:
      "下面是一段报错。用中文说清楚：它到底在说什么、最常见的两三个原因、先查什么。\n" +
      "不确定的地方直接说不确定，不要编一个听起来合理的答案。\n\n{{内容}}",
    sample: "TypeError: Cannot read properties of undefined (reading 'map')\n    at UserList (UserList.tsx:42:18)",
  },
];
